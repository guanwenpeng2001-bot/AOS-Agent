/**
 * External Agent Adapter v1 core contract.
 *
 * An external Agent is a replaceable Worker implementation that a trusted
 * Host composition registers and drives; it is not a second Agent Loop, Run
 * ledger, or scheduler. This module defines the pure control-plane boundary:
 * explicit target selection, side-effect-free protocol probe, capability
 * snapshot, frozen Binding translation, bounded events, a terminal receipt,
 * and stable error codes. Run, Policy, Binding, Receipt, and Audit stay
 * authoritative in their existing layers; an Adapter never writes a Run
 * terminal, a Session entry, an external mapping, or a Policy decision.
 *
 * The contract is intentionally credential-free. Adapter input carries only
 * safe binding references, bounded capability summaries, and stable
 * identifiers; target-owned credentials, headers, endpoints, prompts, and
 * raw protocol data never cross this boundary. The `message` in an input is
 * a bounded in-memory Run input: it may reach a target during one start
 * call, but it never enters a prepared binding, receipt, event, mapping, or
 * audit summary.
 *
 * A target is only usable for a controlled Run after `probe` proves
 * protocol/version and the minimum capability gate (start, terminal receipt,
 * cooperative or strong cancel). When an outcome cannot prove whether side
 * effects occurred, the contract fails closed to
 * `external_agent_side_effect_unknown` and never retries.
 *
 * `runExternalAgentAdapter` is the in-process host-side driver: it validates
 * the start request exactly, forwards `adapter.start`, validates and bounds
 * every emitted event, enforces idempotent cancel, validates the terminal
 * receipt, and maps unverifiable outcomes to stable failed receipts. It uses
 * only the safe types of this module plus the shared safe types of
 * binding-handles (public binding associations), remote-operation (side
 * effect state, lease, artifact references), and external-session-mapping
 * (external execution refs and safe identifiers).
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import { createHash } from "node:crypto";
import { parseRunBindingAssociation, type RunBindingAssociation } from "./binding-handles.ts";
import {
	isCanonicalExternalMappingTimestamp,
	isExternalExecutionRef,
	isExternalMappingIdentifier,
	type ExternalExecutionRef,
} from "./external-session-mapping.ts";
import {
	REMOTE_ARTIFACT_KINDS,
	REMOTE_OPERATION_SIDE_EFFECT_STATES,
	type RemoteArtifactKind,
	type RemoteArtifactReference,
	type RemoteOperationLease,
	type RemoteOperationSideEffectState,
} from "./remote-operation.ts";

export const EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_AGENT_BINDING_FINGERPRINT_PREFIX = "ext-binding:" as const;

export const EXTERNAL_AGENT_PROBE_STATUSES = ["ready", "unavailable", "incompatible"] as const;
export type ExternalAgentProbeStatus = (typeof EXTERNAL_AGENT_PROBE_STATUSES)[number];

export const EXTERNAL_AGENT_EVENT_MODES = ["none", "metadata", "stream"] as const;
export type ExternalAgentEventMode = (typeof EXTERNAL_AGENT_EVENT_MODES)[number];

export const EXTERNAL_AGENT_CANCEL_MODES = ["cooperative", "strong", "none"] as const;
export type ExternalAgentCancelMode = (typeof EXTERNAL_AGENT_CANCEL_MODES)[number];

export const EXTERNAL_AGENT_RECEIPT_MODES = ["terminal", "none"] as const;
export type ExternalAgentReceiptMode = (typeof EXTERNAL_AGENT_RECEIPT_MODES)[number];

export const EXTERNAL_AGENT_BINDING_MODES = ["reference-only", "tool-gateway"] as const;
export type ExternalAgentBindingMode = (typeof EXTERNAL_AGENT_BINDING_MODES)[number];

export const EXTERNAL_AGENT_EVENT_TYPES = ["started", "progress", "artifact"] as const;
export type ExternalAgentEventType = (typeof EXTERNAL_AGENT_EVENT_TYPES)[number];

export const EXTERNAL_AGENT_RECEIPT_STATUSES = ["completed", "failed", "cancelled"] as const;
export type ExternalAgentReceiptStatus = (typeof EXTERNAL_AGENT_RECEIPT_STATUSES)[number];

export const EXTERNAL_AGENT_ERROR_CODES = [
	"external_agent_adapter_invalid",
	"external_agent_target_not_found",
	"external_agent_probe_failed",
	"external_agent_protocol_unsupported",
	"external_agent_capability_missing",
	"external_agent_binding_unsupported",
	"external_agent_start_failed",
	"external_agent_mapping_invalid",
	"external_agent_mapping_conflict",
	"external_agent_cancel_unsupported",
	"external_agent_cancel_failed",
	"external_agent_receipt_invalid",
	"external_agent_side_effect_unknown",
	"external_agent_resume_unsupported",
	"external_agent_persistence_failed",
] as const;
export type ExternalAgentErrorCode = (typeof EXTERNAL_AGENT_ERROR_CODES)[number];

/** Resource-protection bounds shared by every public value of this module. */
export const EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH = 128;
export const EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH = 256;
export const EXTERNAL_AGENT_PROTOCOL_NAME_MAX_LENGTH = 128;
export const EXTERNAL_AGENT_PROTOCOL_VERSION_MAX_LENGTH = 64;
export const EXTERNAL_AGENT_REASON_CODE_MAX_LENGTH = 128;
export const EXTERNAL_AGENT_PHASE_MAX_LENGTH = 64;
export const EXTERNAL_AGENT_PROFILE_MAX_LENGTH = 128;
export const EXTERNAL_AGENT_CAPABILITY_SUMMARY_ITEM_MAX_LENGTH = 64;
export const EXTERNAL_AGENT_MAX_CAPABILITY_SUMMARY = 64;
export const EXTERNAL_AGENT_MAX_EVENTS = 256;
export const EXTERNAL_AGENT_MAX_ARTIFACT_REFS = 64;
export const EXTERNAL_AGENT_MAX_IMAGES = 8;
export const EXTERNAL_AGENT_MAX_MESSAGE_LENGTH = 256 * 1024;

/** A target inside a trusted Adapter; the public side only sees its opaque id. */
export interface ExternalAgentTarget {
	readonly targetId: string;
}

/** Explicit selection of a trusted Adapter and one of its known targets. */
export interface ExternalAgentSelection {
	readonly adapterId: string;
	readonly targetId: string;
}

/** Probe input. A probe must have a deadline and must not carry business input. */
export interface ExternalAgentProbeContext {
	readonly signal: AbortSignal;
	readonly deadlineAt?: string;
}

export interface ExternalAgentProtocol {
	readonly name: string;
	readonly version: string;
}

/** Capability flags a target reports before any business execution. */
export interface ExternalAgentCapabilityFlags {
	readonly start: boolean;
	readonly events: ExternalAgentEventMode;
	readonly cancel: ExternalAgentCancelMode;
	readonly receipt: ExternalAgentReceiptMode;
	readonly resume: boolean;
	readonly artifacts: boolean;
	readonly toolGateway: boolean;
}

/**
 * The capability shape a prepared binding commits to. `start` is fixed,
 * `receipt` is fixed to a terminal receipt, and `cancel` can never be
 * `none`: the capability gate must have passed before a binding is prepared.
 */
export interface ExternalAgentRequiredCapabilityFlags {
	readonly start: true;
	readonly events: ExternalAgentEventMode;
	readonly cancel: "cooperative" | "strong";
	readonly receipt: "terminal";
	readonly resume: boolean;
	readonly artifacts: boolean;
	readonly toolGateway: boolean;
}

/** Safe capability summary produced by a probe; no raw protocol data. */
export interface ExternalAgentCapabilitySnapshot {
	readonly schemaVersion: typeof EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION;
	readonly adapterId: string;
	readonly targetId: string;
	readonly protocol: ExternalAgentProtocol;
	readonly status: ExternalAgentProbeStatus;
	readonly capabilities: ExternalAgentCapabilityFlags;
	readonly reasonCode?: string;
	readonly observedAt: string;
}

/**
 * Public-safe Binding input: the frozen Model / Capability / Policy / Sandbox
 * references of one Run. Credentials, raw policy, sandbox secrets, and full
 * environments never appear here.
 */
export interface ExternalAgentBindingInput {
	readonly runId: string;
	readonly sessionId: string;
	readonly modelBindingId?: string;
	readonly capabilityBindingId?: string;
	readonly policyBindingId?: string;
	readonly bindingAssociation?: RunBindingAssociation;
	/** Bounded allowlisted capability summary of the current Run. */
	readonly capabilitySummary: ReadonlyArray<string>;
	readonly policyProfile?: string;
	readonly sandboxProfile?: string;
}

export interface ExternalAgentPrepareRequest extends ExternalAgentBindingInput {
	readonly selection: ExternalAgentSelection;
	readonly deadlineAt?: string;
}

/**
 * Immutable translated Binding for one external execution. It is bound to
 * adapterId, targetId, and protocol version; the fingerprint pins it to the
 * Run and the AOS binding facts. It cannot be expanded in place.
 */
export interface ExternalAgentPreparedBinding {
	readonly schemaVersion: typeof EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION;
	readonly adapterId: string;
	readonly targetId: string;
	readonly protocol: ExternalAgentProtocol;
	readonly bindingMode: ExternalAgentBindingMode;
	readonly bindingFingerprint: string;
	readonly capabilities: ExternalAgentRequiredCapabilityFlags;
}

/** Bounded in-memory Run input; images are references only, never bytes. */
export interface ExternalAgentImageReference {
	readonly id: string;
	readonly mimeType: string;
	readonly sizeBytes?: number;
}

export interface ExternalAgentInput {
	readonly message: string;
	readonly images?: ReadonlyArray<ExternalAgentImageReference>;
}

export interface ExternalAgentStartRequest {
	readonly preparedBinding: ExternalAgentPreparedBinding;
	readonly input: ExternalAgentInput;
	readonly operationId: string;
	readonly deadlineAt?: string;
	readonly lease?: RemoteOperationLease;
}

/** Bounded observation events; never transcripts, prompts, or raw output. */
export type ExternalAgentEvent =
	| {
			readonly type: "started";
			readonly external: ExternalExecutionRef;
			readonly timestamp: string;
	  }
	| {
			readonly type: "progress";
			readonly external: ExternalExecutionRef;
			readonly sequence: number;
			readonly phase?: string;
			readonly timestamp: string;
	  }
	| {
			readonly type: "artifact";
			readonly external: ExternalExecutionRef;
			readonly artifact: RemoteArtifactReference;
			readonly timestamp: string;
	  };

export interface ExternalAgentReceiptError {
	readonly code: ExternalAgentErrorCode;
	readonly retryable: boolean;
	readonly sideEffects: RemoteOperationSideEffectState;
}

/**
 * Terminal receipt of one external execution. The side-effect state reuses
 * the Remote Operation vocabulary: an error is only valid on `failed` and a
 * `completed` receipt never carries an error. A `cancelled` receipt with
 * associated or unknown side effects is shape-valid but never surfaces as
 * `cancelled`; `runExternalAgentAdapter` rewrites it to a failed
 * side-effect-unknown outcome.
 */
export interface ExternalAgentReceipt {
	readonly schemaVersion: typeof EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION;
	readonly external: ExternalExecutionRef;
	readonly status: ExternalAgentReceiptStatus;
	readonly endedAt: string;
	readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
	readonly sideEffects: RemoteOperationSideEffectState;
	readonly error?: ExternalAgentReceiptError;
}

/** Execution boundary an Adapter observes while one external execution runs. */
export interface ExternalAgentExecutionContext {
	readonly signal: AbortSignal;
	readonly deadlineAt?: string;
}

/** Handle of one external execution, produced by `adapter.start`. */
export interface ExternalAgentHandle {
	readonly external: ExternalExecutionRef;
	readonly events: AsyncIterable<ExternalAgentEvent>;
	readonly receipt: Promise<ExternalAgentReceipt>;
	cancel(): Promise<void>;
	heartbeat(): Promise<RemoteOperationLease>;
}

/** Trusted Host-side Adapter contract; adapters never write AOS facts. */
export interface ExternalAgentAdapter {
	readonly id: string;
	probe(target: ExternalAgentTarget, context: ExternalAgentProbeContext): Promise<ExternalAgentCapabilitySnapshot>;
	prepare(
		request: ExternalAgentPrepareRequest,
		snapshot: ExternalAgentCapabilitySnapshot,
	): Promise<ExternalAgentPreparedBinding>;
	start(
		request: ExternalAgentStartRequest,
		context: ExternalAgentExecutionContext,
	): Promise<ExternalAgentHandle>;
}

export interface ExternalAgentRunOptions {
	readonly signal?: AbortSignal;
	/** Receipt clock; must return a canonical UTC timestamp. */
	readonly now?: () => string;
	/** Bounded event cap; clamped to [1, EXTERNAL_AGENT_MAX_EVENTS]. */
	readonly maxEvents?: number;
}

/** The validated handle produced by `runExternalAgentAdapter`. */
export interface ExternalAgentRunHandle extends ExternalAgentHandle {
	/** Validated events accepted so far, in order. */
	readonly eventsList: ReadonlyArray<ExternalAgentEvent>;
	/** Events rejected by exact validation, identity checks, or the bound. */
	readonly droppedEvents: number;
	/**
	 * Explicit start-readiness boundary. Resolves to the validated external
	 * execution ref only after `adapter.start` returns and the ref passes
	 * exact validation, so Run/RPC integration can persist the real ref
	 * before `run.started`. Resolves `undefined` on start failure or invalid
	 * identity and never rejects. The `external` getter keeps returning the
	 * fallback identity until this promise resolves, for compatibility.
	 */
	readonly externalReady: Promise<ExternalExecutionRef | undefined>;
}

export interface ExternalAgentEventCollectorOptions {
	readonly maxEvents?: number;
}

/**
 * Bounded, validated event sink. Cross-event rules: one `started` at most,
 * strictly increasing `progress` sequences, a consistent external identity,
 * and a hard event bound. Invalid events are counted and dropped, never
 * surfaced.
 */
export interface ExternalAgentEventCollector {
	readonly events: ReadonlyArray<ExternalAgentEvent>;
	readonly dropped: number;
	readonly truncated: boolean;
	readonly establishedExternal: ExternalExecutionRef | undefined;
	/** Accept one event; returns false when the event was dropped. */
	push(event: unknown): boolean;
}

export interface ExternalAgentPreparedBindingOptions {
	readonly bindingMode?: ExternalAgentBindingMode;
}

/** Facts folded into the deterministic Binding fingerprint. */
export interface ExternalAgentBindingFingerprintFacts {
	readonly runId: string;
	readonly sessionId: string;
	readonly adapterId: string;
	readonly targetId: string;
	readonly protocolName: string;
	readonly protocolVersion: string;
	readonly bindingMode: ExternalAgentBindingMode;
	readonly capabilitySummary: ReadonlyArray<string>;
	readonly modelBindingId?: string;
	readonly capabilityBindingId?: string;
	readonly policyBindingId?: string;
	readonly policyProfile?: string;
	readonly sandboxProfile?: string;
}

export interface ExternalAgentErrorView {
	readonly code: ExternalAgentErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

const EXTERNAL_AGENT_ERROR_MESSAGES: Readonly<Record<ExternalAgentErrorCode, string>> = {
	external_agent_adapter_invalid: "External agent adapter input is invalid.",
	external_agent_target_not_found: "External agent target was not found in the trusted registry.",
	external_agent_probe_failed: "External agent probe failed; the target did not confirm its protocol.",
	external_agent_protocol_unsupported: "External agent protocol or version is not supported.",
	external_agent_capability_missing: "External agent target lacks a required capability.",
	external_agent_binding_unsupported: "The current AOS binding cannot be translated to this external target.",
	external_agent_start_failed: "External agent execution could not be started or confirmed.",
	external_agent_mapping_invalid: "External agent returned an invalid external execution identity.",
	external_agent_mapping_conflict: "External agent identity conflicts with append-only mapping history.",
	external_agent_cancel_unsupported: "External agent target cannot verify cancellation.",
	external_agent_cancel_failed: "External agent cancellation request failed.",
	external_agent_receipt_invalid: "External agent terminal receipt is missing, malformed, or mismatched.",
	external_agent_side_effect_unknown: "External agent outcome cannot prove whether side effects occurred.",
	external_agent_resume_unsupported: "External agent target cannot resume this execution.",
	external_agent_persistence_failed: "External agent facts could not be persisted durably.",
};

/** Stable error with a code-derived message; raw provider detail never escapes. */
export class ExternalAgentError extends Error {
	readonly code: ExternalAgentErrorCode;
	readonly retryable: boolean;

	constructor(code: ExternalAgentErrorCode) {
		// Errors cross RPC boundaries as Error.message. Keep that channel
		// code-derived so caller payloads, paths, commands, and credentials
		// cannot escape through a caller-supplied message.
		super(EXTERNAL_AGENT_ERROR_MESSAGES[code]);
		this.name = "ExternalAgentError";
		this.code = code;
		this.retryable = code === "external_agent_probe_failed" || code === "external_agent_cancel_failed";
	}

	toJSON(): ExternalAgentErrorView {
		return { code: this.code, message: EXTERNAL_AGENT_ERROR_MESSAGES[this.code], retryable: this.retryable };
	}
}

const SAFE_ARTIFACT_DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_MEDIA_TYPE_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const EXTERNAL_AGENT_BINDING_FINGERPRINT_PATTERN = /^ext-binding:[A-Za-z0-9_-]{43,64}$/;

const TARGET_KEYS = new Set(["targetId"]);
const SELECTION_KEYS = new Set(["adapterId", "targetId"]);
const PROBE_CONTEXT_KEYS = new Set(["signal", "deadlineAt"]);
const PROTOCOL_KEYS = new Set(["name", "version"]);
const CAPABILITY_FLAG_KEYS = new Set(["start", "events", "cancel", "receipt", "resume", "artifacts", "toolGateway"]);
const SNAPSHOT_KEYS = new Set([
	"schemaVersion",
	"adapterId",
	"targetId",
	"protocol",
	"status",
	"capabilities",
	"reasonCode",
	"observedAt",
]);
const BINDING_INPUT_KEYS = new Set([
	"runId",
	"sessionId",
	"modelBindingId",
	"capabilityBindingId",
	"policyBindingId",
	"bindingAssociation",
	"capabilitySummary",
	"policyProfile",
	"sandboxProfile",
]);
const PREPARE_REQUEST_KEYS = new Set([...BINDING_INPUT_KEYS, "selection", "deadlineAt"]);
const PREPARED_BINDING_KEYS = new Set([
	"schemaVersion",
	"adapterId",
	"targetId",
	"protocol",
	"bindingMode",
	"bindingFingerprint",
	"capabilities",
]);
const IMAGE_REFERENCE_KEYS = new Set(["id", "mimeType", "sizeBytes"]);
const INPUT_KEYS = new Set(["message", "images"]);
const START_REQUEST_KEYS = new Set(["preparedBinding", "input", "operationId", "deadlineAt", "lease"]);
const STARTED_EVENT_KEYS = new Set(["type", "external", "timestamp"]);
const PROGRESS_EVENT_KEYS = new Set(["type", "external", "sequence", "phase", "timestamp"]);
const ARTIFACT_EVENT_KEYS = new Set(["type", "external", "artifact", "timestamp"]);
const RECEIPT_KEYS = new Set(["schemaVersion", "external", "status", "endedAt", "artifactRefs", "sideEffects", "error"]);
const RECEIPT_ERROR_KEYS = new Set(["code", "retryable", "sideEffects"]);
const LEASE_KEYS = new Set(["leaseId", "expiresAt"]);
const ARTIFACT_KEYS = new Set(["id", "kind", "digest", "sizeBytes", "mediaType"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

/** Safe identifiers reject paths, URLs, userinfo, query text, and controls. */
export function isExternalAgentIdentifier(value: unknown): value is string {
	return isExternalMappingIdentifier(value);
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength && isExternalMappingIdentifier(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedIdentifierList(
	value: unknown,
	itemMaxLength: number,
	maxItems: number,
): value is ReadonlyArray<string> {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every((item) => isBoundedIdentifier(item, itemMaxLength))
	);
}

function isSafeLease(value: unknown): value is RemoteOperationLease {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, LEASE_KEYS) &&
		isExternalMappingIdentifier(value.leaseId) &&
		isCanonicalExternalMappingTimestamp(value.expiresAt)
	);
}

function isSafeArtifactReference(value: unknown): value is RemoteArtifactReference {
	if (!isRecord(value) || !hasOnlyKeys(value, ARTIFACT_KEYS)) return false;
	if (!isExternalMappingIdentifier(value.id) || !REMOTE_ARTIFACT_KINDS.includes(value.kind as RemoteArtifactKind)) {
		return false;
	}
	if (
		value.digest !== undefined &&
		(typeof value.digest !== "string" || !SAFE_ARTIFACT_DIGEST_PATTERN.test(value.digest))
	) {
		return false;
	}
	if (
		value.sizeBytes !== undefined &&
		(typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)
	) {
		return false;
	}
	if (
		value.mediaType !== undefined &&
		(typeof value.mediaType !== "string" || !SAFE_MEDIA_TYPE_PATTERN.test(value.mediaType))
	) {
		return false;
	}
	return true;
}

function isSafeArtifactReferenceList(value: unknown, maxItems: number): value is ReadonlyArray<RemoteArtifactReference> {
	return Array.isArray(value) && value.length <= maxItems && value.every(isSafeArtifactReference);
}

export function isExternalAgentTarget(value: unknown): value is ExternalAgentTarget {
	return isRecord(value) && hasOnlyKeys(value, TARGET_KEYS) && isBoundedIdentifier(value.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH);
}

export function isExternalAgentSelection(value: unknown): value is ExternalAgentSelection {
	if (!isRecord(value) || !hasOnlyKeys(value, SELECTION_KEYS)) return false;
	return (
		isBoundedIdentifier(value.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) &&
		isBoundedIdentifier(value.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)
	);
}

export function isExternalAgentProbeContext(value: unknown): value is ExternalAgentProbeContext {
	if (!isRecord(value) || !hasOnlyKeys(value, PROBE_CONTEXT_KEYS)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalExternalMappingTimestamp(value.deadlineAt)) return false;
	const signal = value.signal;
	return (
		signal !== null &&
		typeof signal === "object" &&
		typeof (signal as { aborted?: unknown }).aborted === "boolean" &&
		typeof (signal as { addEventListener?: unknown }).addEventListener === "function"
	);
}

export function isExternalAgentProtocol(value: unknown): value is ExternalAgentProtocol {
	if (!isRecord(value) || !hasOnlyKeys(value, PROTOCOL_KEYS)) return false;
	return (
		isBoundedIdentifier(value.name, EXTERNAL_AGENT_PROTOCOL_NAME_MAX_LENGTH) &&
		isBoundedIdentifier(value.version, EXTERNAL_AGENT_PROTOCOL_VERSION_MAX_LENGTH)
	);
}

export function isExternalAgentCapabilityFlags(value: unknown): value is ExternalAgentCapabilityFlags {
	if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITY_FLAG_KEYS)) return false;
	return (
		typeof value.start === "boolean" &&
		EXTERNAL_AGENT_EVENT_MODES.includes(value.events as ExternalAgentEventMode) &&
		EXTERNAL_AGENT_CANCEL_MODES.includes(value.cancel as ExternalAgentCancelMode) &&
		EXTERNAL_AGENT_RECEIPT_MODES.includes(value.receipt as ExternalAgentReceiptMode) &&
		typeof value.resume === "boolean" &&
		typeof value.artifacts === "boolean" &&
		typeof value.toolGateway === "boolean"
	);
}

export function isExternalAgentCapabilitySnapshot(value: unknown): value is ExternalAgentCapabilitySnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return false;
	if (value.schemaVersion !== EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION) return false;
	if (!isBoundedIdentifier(value.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH)) return false;
	if (!isBoundedIdentifier(value.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)) return false;
	if (!isExternalAgentProtocol(value.protocol)) return false;
	if (!EXTERNAL_AGENT_PROBE_STATUSES.includes(value.status as ExternalAgentProbeStatus)) return false;
	if (value.reasonCode !== undefined && !isBoundedIdentifier(value.reasonCode, EXTERNAL_AGENT_REASON_CODE_MAX_LENGTH)) {
		return false;
	}
	if (!isCanonicalExternalMappingTimestamp(value.observedAt)) return false;
	return isExternalAgentCapabilityFlags(value.capabilities);
}

function hasValidBindingInputFields(value: Record<string, unknown>): boolean {
	if (!isExternalMappingIdentifier(value.runId) || !isExternalMappingIdentifier(value.sessionId)) return false;
	if (value.modelBindingId !== undefined && !isExternalMappingIdentifier(value.modelBindingId)) return false;
	if (value.capabilityBindingId !== undefined && !isExternalMappingIdentifier(value.capabilityBindingId)) return false;
	if (value.policyBindingId !== undefined && !isExternalMappingIdentifier(value.policyBindingId)) return false;
	if (
		!isBoundedIdentifierList(
			value.capabilitySummary,
			EXTERNAL_AGENT_CAPABILITY_SUMMARY_ITEM_MAX_LENGTH,
			EXTERNAL_AGENT_MAX_CAPABILITY_SUMMARY,
		)
	) {
		return false;
	}
	if (value.policyProfile !== undefined && !isBoundedIdentifier(value.policyProfile, EXTERNAL_AGENT_PROFILE_MAX_LENGTH)) {
		return false;
	}
	if (value.sandboxProfile !== undefined && !isBoundedIdentifier(value.sandboxProfile, EXTERNAL_AGENT_PROFILE_MAX_LENGTH)) {
		return false;
	}
	if (value.bindingAssociation !== undefined) {
		const association = parseRunBindingAssociation(value.bindingAssociation);
		if (association === undefined || association.runId !== value.runId) return false;
	}
	return true;
}

export function isExternalAgentBindingInput(value: unknown): value is ExternalAgentBindingInput {
	return isRecord(value) && hasOnlyKeys(value, BINDING_INPUT_KEYS) && hasValidBindingInputFields(value);
}

export function isExternalAgentPrepareRequest(value: unknown): value is ExternalAgentPrepareRequest {
	if (!isRecord(value) || !hasOnlyKeys(value, PREPARE_REQUEST_KEYS)) return false;
	if (!hasValidBindingInputFields(value)) return false;
	if (!isExternalAgentSelection(value.selection)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalExternalMappingTimestamp(value.deadlineAt)) return false;
	return true;
}

export function isExternalAgentBindingFingerprint(value: unknown): value is string {
	return typeof value === "string" && EXTERNAL_AGENT_BINDING_FINGERPRINT_PATTERN.test(value);
}

export function isExternalAgentRequiredCapabilityFlags(value: unknown): value is ExternalAgentRequiredCapabilityFlags {
	if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITY_FLAG_KEYS)) return false;
	return (
		value.start === true &&
		EXTERNAL_AGENT_EVENT_MODES.includes(value.events as ExternalAgentEventMode) &&
		(value.cancel === "cooperative" || value.cancel === "strong") &&
		value.receipt === "terminal" &&
		typeof value.resume === "boolean" &&
		typeof value.artifacts === "boolean" &&
		typeof value.toolGateway === "boolean"
	);
}

export function isExternalAgentPreparedBinding(value: unknown): value is ExternalAgentPreparedBinding {
	if (!isRecord(value) || !hasOnlyKeys(value, PREPARED_BINDING_KEYS)) return false;
	if (value.schemaVersion !== EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION) return false;
	if (!isBoundedIdentifier(value.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH)) return false;
	if (!isBoundedIdentifier(value.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)) return false;
	if (!isExternalAgentProtocol(value.protocol)) return false;
	if (!EXTERNAL_AGENT_BINDING_MODES.includes(value.bindingMode as ExternalAgentBindingMode)) return false;
	if (!isExternalAgentBindingFingerprint(value.bindingFingerprint)) return false;
	return isExternalAgentRequiredCapabilityFlags(value.capabilities);
}

export function isExternalAgentImageReference(value: unknown): value is ExternalAgentImageReference {
	if (!isRecord(value) || !hasOnlyKeys(value, IMAGE_REFERENCE_KEYS)) return false;
	return (
		isExternalMappingIdentifier(value.id) &&
		typeof value.mimeType === "string" &&
		SAFE_MEDIA_TYPE_PATTERN.test(value.mimeType) &&
		(value.sizeBytes === undefined ||
			(typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0))
	);
}

export function isExternalAgentInput(value: unknown): value is ExternalAgentInput {
	if (!isRecord(value) || !hasOnlyKeys(value, INPUT_KEYS)) return false;
	if (typeof value.message !== "string" || value.message.length < 1 || value.message.length > EXTERNAL_AGENT_MAX_MESSAGE_LENGTH) {
		return false;
	}
	if (
		value.images !== undefined &&
		(!Array.isArray(value.images) ||
			value.images.length > EXTERNAL_AGENT_MAX_IMAGES ||
			!value.images.every(isExternalAgentImageReference))
	) {
		return false;
	}
	return true;
}

export function isExternalAgentStartRequest(value: unknown): value is ExternalAgentStartRequest {
	if (!isRecord(value) || !hasOnlyKeys(value, START_REQUEST_KEYS)) return false;
	if (!isExternalAgentPreparedBinding(value.preparedBinding)) return false;
	if (!isExternalAgentInput(value.input)) return false;
	if (!isExternalMappingIdentifier(value.operationId)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalExternalMappingTimestamp(value.deadlineAt)) return false;
	if (value.lease !== undefined && !isSafeLease(value.lease)) return false;
	return true;
}

export function isExternalAgentEvent(value: unknown): value is ExternalAgentEvent {
	if (!isRecord(value)) return false;
	if (value.type === "started") {
		if (!hasOnlyKeys(value, STARTED_EVENT_KEYS)) return false;
		return isExternalExecutionRef(value.external) && isCanonicalExternalMappingTimestamp(value.timestamp);
	}
	if (value.type === "progress") {
		if (!hasOnlyKeys(value, PROGRESS_EVENT_KEYS)) return false;
		return (
			isExternalExecutionRef(value.external) &&
			isPositiveSafeInteger(value.sequence) &&
			(value.phase === undefined || isBoundedIdentifier(value.phase, EXTERNAL_AGENT_PHASE_MAX_LENGTH)) &&
			isCanonicalExternalMappingTimestamp(value.timestamp)
		);
	}
	if (value.type === "artifact") {
		if (!hasOnlyKeys(value, ARTIFACT_EVENT_KEYS)) return false;
		return (
			isExternalExecutionRef(value.external) &&
			isSafeArtifactReference(value.artifact) &&
			isCanonicalExternalMappingTimestamp(value.timestamp)
		);
	}
	return false;
}

export function isExternalAgentReceiptError(value: unknown): value is ExternalAgentReceiptError {
	if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_ERROR_KEYS)) return false;
	if (typeof value.retryable !== "boolean") return false;
	if (!REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState)) return false;
	return EXTERNAL_AGENT_ERROR_CODES.includes(value.code as ExternalAgentErrorCode);
}

/**
 * Exact side-effect-safe receipt validation: unknown keys are rejected, an
 * error is only valid on `failed`, and artifact refs are bounded. The
 * interpretation of a `cancelled` receipt that still reports associated or
 * unknown side effects is the driver's job: it never becomes `cancelled`.
 */
export function isExternalAgentReceipt(value: unknown): value is ExternalAgentReceipt {
	if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) return false;
	if (value.schemaVersion !== EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION) return false;
	if (!isExternalExecutionRef(value.external)) return false;
	if (!EXTERNAL_AGENT_RECEIPT_STATUSES.includes(value.status as ExternalAgentReceiptStatus)) return false;
	if (!isCanonicalExternalMappingTimestamp(value.endedAt)) return false;
	if (!isSafeArtifactReferenceList(value.artifactRefs, EXTERNAL_AGENT_MAX_ARTIFACT_REFS)) return false;
	if (!REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState)) return false;
	if (value.error !== undefined) {
		if (!isExternalAgentReceiptError(value.error)) return false;
		if (value.status !== "failed") return false;
	} else if (value.status === "failed") {
		return false;
	}
	return true;
}

function cloneExternalExecutionRef(value: ExternalExecutionRef): ExternalExecutionRef {
	return {
		namespace: value.namespace,
		externalSessionId: value.externalSessionId,
		...(value.externalRunId === undefined ? {} : { externalRunId: value.externalRunId }),
	};
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

function cloneReceiptError(value: ExternalAgentReceiptError): ExternalAgentReceiptError {
	return Object.freeze({ code: value.code, retryable: value.retryable, sideEffects: value.sideEffects });
}

/** Exact allowlist serializers; they return undefined for any invalid value. */
export function serializeExternalAgentTarget(value: unknown): ExternalAgentTarget | undefined {
	if (!isExternalAgentTarget(value)) return undefined;
	return deepFreeze({ targetId: value.targetId });
}

export function serializeExternalAgentSelection(value: unknown): ExternalAgentSelection | undefined {
	if (!isExternalAgentSelection(value)) return undefined;
	return deepFreeze({ adapterId: value.adapterId, targetId: value.targetId });
}

export function serializeExternalAgentCapabilitySnapshot(value: unknown): ExternalAgentCapabilitySnapshot | undefined {
	if (!isExternalAgentCapabilitySnapshot(value)) return undefined;
	return deepFreeze({
		schemaVersion: value.schemaVersion,
		adapterId: value.adapterId,
		targetId: value.targetId,
		protocol: { name: value.protocol.name, version: value.protocol.version },
		status: value.status,
		capabilities: {
			start: value.capabilities.start,
			events: value.capabilities.events,
			cancel: value.capabilities.cancel,
			receipt: value.capabilities.receipt,
			resume: value.capabilities.resume,
			artifacts: value.capabilities.artifacts,
			toolGateway: value.capabilities.toolGateway,
		},
		...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
		observedAt: value.observedAt,
	});
}

export function serializeExternalAgentPreparedBinding(value: unknown): ExternalAgentPreparedBinding | undefined {
	if (!isExternalAgentPreparedBinding(value)) return undefined;
	return deepFreeze({
		schemaVersion: value.schemaVersion,
		adapterId: value.adapterId,
		targetId: value.targetId,
		protocol: { name: value.protocol.name, version: value.protocol.version },
		bindingMode: value.bindingMode,
		bindingFingerprint: value.bindingFingerprint,
		capabilities: {
			start: value.capabilities.start,
			events: value.capabilities.events,
			cancel: value.capabilities.cancel,
			receipt: value.capabilities.receipt,
			resume: value.capabilities.resume,
			artifacts: value.capabilities.artifacts,
			toolGateway: value.capabilities.toolGateway,
		},
	});
}

export function serializeExternalAgentInput(value: unknown): ExternalAgentInput | undefined {
	if (!isExternalAgentInput(value)) return undefined;
	return deepFreeze({
		message: value.message,
		...(value.images === undefined
			? {}
			: {
					images: value.images.map((image) => ({
						id: image.id,
						mimeType: image.mimeType,
						...(image.sizeBytes === undefined ? {} : { sizeBytes: image.sizeBytes }),
					})),
				}),
	});
}

export function serializeExternalAgentEvent(value: unknown): ExternalAgentEvent | undefined {
	if (!isExternalAgentEvent(value)) return undefined;
	if (value.type === "started") {
		return deepFreeze({ type: "started", external: cloneExternalExecutionRef(value.external), timestamp: value.timestamp });
	}
	if (value.type === "progress") {
		return deepFreeze({
			type: "progress",
			external: cloneExternalExecutionRef(value.external),
			sequence: value.sequence,
			...(value.phase === undefined ? {} : { phase: value.phase }),
			timestamp: value.timestamp,
		});
	}
	return deepFreeze({
		type: "artifact",
		external: cloneExternalExecutionRef(value.external),
		artifact: cloneArtifactReference(value.artifact),
		timestamp: value.timestamp,
	});
}

export function serializeExternalAgentReceipt(value: unknown): ExternalAgentReceipt | undefined {
	if (!isExternalAgentReceipt(value)) return undefined;
	return deepFreeze({
		schemaVersion: value.schemaVersion,
		external: cloneExternalExecutionRef(value.external),
		status: value.status,
		endedAt: value.endedAt,
		artifactRefs: value.artifactRefs.map(cloneArtifactReference),
		sideEffects: value.sideEffects,
		...(value.error === undefined ? {} : { error: cloneReceiptError(value.error) }),
	});
}

/** Clone helpers throw a stable error for invalid values. */
export function cloneExternalAgentTarget(value: unknown): ExternalAgentTarget {
	const clone = serializeExternalAgentTarget(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentSelection(value: unknown): ExternalAgentSelection {
	const clone = serializeExternalAgentSelection(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentCapabilitySnapshot(value: unknown): ExternalAgentCapabilitySnapshot {
	const clone = serializeExternalAgentCapabilitySnapshot(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentPreparedBinding(value: unknown): ExternalAgentPreparedBinding {
	const clone = serializeExternalAgentPreparedBinding(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentInput(value: unknown): ExternalAgentInput {
	const clone = serializeExternalAgentInput(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentEvent(value: unknown): ExternalAgentEvent {
	const clone = serializeExternalAgentEvent(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

export function cloneExternalAgentReceipt(value: unknown): ExternalAgentReceipt {
	const clone = serializeExternalAgentReceipt(value);
	if (clone === undefined) throw new ExternalAgentError("external_agent_adapter_invalid");
	return clone;
}

function sameExternalRef(left: ExternalExecutionRef, right: ExternalExecutionRef): boolean {
	return (
		left.namespace === right.namespace &&
		left.externalSessionId === right.externalSessionId &&
		(left.externalRunId ?? undefined) === (right.externalRunId ?? undefined)
	);
}

function clampEventLimit(value: number | undefined): number {
	if (value === undefined) return EXTERNAL_AGENT_MAX_EVENTS;
	if (!Number.isFinite(value)) return EXTERNAL_AGENT_MAX_EVENTS;
	return Math.min(EXTERNAL_AGENT_MAX_EVENTS, Math.max(1, Math.floor(value)));
}

export function createExternalAgentEventCollector(
	options: ExternalAgentEventCollectorOptions = {},
): ExternalAgentEventCollector {
	const maxEvents = clampEventLimit(options.maxEvents);
	let events: ReadonlyArray<ExternalAgentEvent> = Object.freeze([]);
	let dropped = 0;
	let truncated = false;
	let established: ExternalExecutionRef | undefined;
	let lastSequence = 0;
	let startedSeen = false;
	return {
		get events() {
			return events;
		},
		get dropped() {
			return dropped;
		},
		get truncated() {
			return truncated;
		},
		get establishedExternal() {
			return established;
		},
		push(raw) {
			if (!isExternalAgentEvent(raw)) {
				dropped += 1;
				return false;
			}
			if (established !== undefined && !sameExternalRef(established, raw.external)) {
				dropped += 1;
				return false;
			}
			if (raw.type === "started") {
				if (startedSeen) {
					dropped += 1;
					return false;
				}
				startedSeen = true;
			}
			if (raw.type === "progress") {
				if (raw.sequence <= lastSequence) {
					dropped += 1;
					return false;
				}
				lastSequence = raw.sequence;
			}
			if (events.length >= maxEvents) {
				dropped += 1;
				truncated = true;
				return false;
			}
			established ??= raw.external;
			events = Object.freeze([...events, raw]);
			return true;
		},
	};
}

/**
 * Deterministic Binding fingerprint over the frozen safe facts. Reordered
 * capability summaries produce the same fingerprint; any binding fact change
 * produces a different one. The digest is not a reversible encoding of the
 * binding content.
 */
export function createExternalAgentBindingFingerprint(facts: ExternalAgentBindingFingerprintFacts): string {
	const capabilitySummary = [...new Set([...facts.capabilitySummary].sort())];
	const canonical = {
		runId: facts.runId,
		sessionId: facts.sessionId,
		adapterId: facts.adapterId,
		targetId: facts.targetId,
		protocolName: facts.protocolName,
		protocolVersion: facts.protocolVersion,
		bindingMode: facts.bindingMode,
		capabilitySummary,
		...(facts.modelBindingId === undefined ? {} : { modelBindingId: facts.modelBindingId }),
		...(facts.capabilityBindingId === undefined ? {} : { capabilityBindingId: facts.capabilityBindingId }),
		...(facts.policyBindingId === undefined ? {} : { policyBindingId: facts.policyBindingId }),
		...(facts.policyProfile === undefined ? {} : { policyProfile: facts.policyProfile }),
		...(facts.sandboxProfile === undefined ? {} : { sandboxProfile: facts.sandboxProfile }),
	};
	return `${EXTERNAL_AGENT_BINDING_FINGERPRINT_PREFIX}${createHash("sha256")
		.update(JSON.stringify(canonical), "utf8")
		.digest("base64url")}`;
}

/** Fingerprint for a prepare request against a probed snapshot. */
export function externalAgentBindingFingerprintFor(
	request: ExternalAgentPrepareRequest,
	snapshot: ExternalAgentCapabilitySnapshot,
	bindingMode: ExternalAgentBindingMode,
): string {
	return createExternalAgentBindingFingerprint({
		runId: request.runId,
		sessionId: request.sessionId,
		adapterId: request.selection.adapterId,
		targetId: request.selection.targetId,
		protocolName: snapshot.protocol.name,
		protocolVersion: snapshot.protocol.version,
		bindingMode,
		capabilitySummary: request.capabilitySummary,
		...(request.modelBindingId === undefined ? {} : { modelBindingId: request.modelBindingId }),
		...(request.capabilityBindingId === undefined ? {} : { capabilityBindingId: request.capabilityBindingId }),
		...(request.policyBindingId === undefined ? {} : { policyBindingId: request.policyBindingId }),
		...(request.policyProfile === undefined ? {} : { policyProfile: request.policyProfile }),
		...(request.sandboxProfile === undefined ? {} : { sandboxProfile: request.sandboxProfile }),
	});
}

/**
 * Reduce a snapshot to the stable error that blocks a controlled Run.
 * `ready` only means the target may enter Binding preflight.
 */
export function externalAgentCapabilityError(snapshot: ExternalAgentCapabilitySnapshot): ExternalAgentErrorCode | undefined {
	if (snapshot.status === "unavailable") return "external_agent_probe_failed";
	if (snapshot.status === "incompatible") return "external_agent_protocol_unsupported";
	if (
		!snapshot.capabilities.start ||
		snapshot.capabilities.receipt !== "terminal" ||
		snapshot.capabilities.cancel === "none"
	) {
		return "external_agent_capability_missing";
	}
	return undefined;
}

export function externalAgentMeetsMinimumCapabilities(snapshot: ExternalAgentCapabilitySnapshot): boolean {
	return externalAgentCapabilityError(snapshot) === undefined;
}

/**
 * Pure default Binding translator: validates the prepare request and the
 * snapshot exactly, applies the minimum capability gate, translates the
 * selection and protocol into an immutable prepared binding, and binds it to
 * the Run through the deterministic fingerprint. `tool-gateway` is only
 * accepted when the target proves the capability.
 */
export function createExternalAgentPreparedBinding(
	request: ExternalAgentPrepareRequest,
	snapshot: ExternalAgentCapabilitySnapshot,
	options: ExternalAgentPreparedBindingOptions = {},
): ExternalAgentPreparedBinding {
	if (!isExternalAgentPrepareRequest(request) || !isExternalAgentCapabilitySnapshot(snapshot)) {
		throw new ExternalAgentError("external_agent_adapter_invalid");
	}
	if (request.selection.adapterId !== snapshot.adapterId || request.selection.targetId !== snapshot.targetId) {
		throw new ExternalAgentError("external_agent_adapter_invalid");
	}
	const capabilityError = externalAgentCapabilityError(snapshot);
	if (capabilityError !== undefined) throw new ExternalAgentError(capabilityError);
	const bindingMode = options.bindingMode ?? "reference-only";
	if (bindingMode === "tool-gateway" && !snapshot.capabilities.toolGateway) {
		throw new ExternalAgentError("external_agent_capability_missing");
	}
	return deepFreeze({
		schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
		adapterId: snapshot.adapterId,
		targetId: snapshot.targetId,
		protocol: { name: snapshot.protocol.name, version: snapshot.protocol.version },
		bindingMode,
		bindingFingerprint: externalAgentBindingFingerprintFor(request, snapshot, bindingMode),
		capabilities: {
			start: true,
			events: snapshot.capabilities.events,
			cancel: snapshot.capabilities.cancel === "strong" ? "strong" : "cooperative",
			receipt: "terminal",
			resume: snapshot.capabilities.resume,
			artifacts: snapshot.capabilities.artifacts,
			toolGateway: snapshot.capabilities.toolGateway,
		},
	});
}

/**
 * Verify a prepared binding against the prepare request and snapshot:
 * identity, protocol, capability flags, and the recomputed fingerprint must
 * all match.
 */
export function verifyExternalAgentPreparedBinding(
	prepared: ExternalAgentPreparedBinding,
	request: ExternalAgentPrepareRequest,
	snapshot: ExternalAgentCapabilitySnapshot,
): boolean {
	if (
		!isExternalAgentPreparedBinding(prepared) ||
		!isExternalAgentPrepareRequest(request) ||
		!isExternalAgentCapabilitySnapshot(snapshot)
	) {
		return false;
	}
	if (prepared.adapterId !== request.selection.adapterId || prepared.targetId !== request.selection.targetId) {
		return false;
	}
	if (prepared.protocol.name !== snapshot.protocol.name || prepared.protocol.version !== snapshot.protocol.version) {
		return false;
	}
	if (
		prepared.capabilities.events !== snapshot.capabilities.events ||
		prepared.capabilities.cancel !== snapshot.capabilities.cancel ||
		prepared.capabilities.resume !== snapshot.capabilities.resume ||
		prepared.capabilities.artifacts !== snapshot.capabilities.artifacts ||
		prepared.capabilities.toolGateway !== snapshot.capabilities.toolGateway
	) {
		return false;
	}
	if (prepared.bindingMode === "tool-gateway" && !snapshot.capabilities.toolGateway) return false;
	return prepared.bindingFingerprint === externalAgentBindingFingerprintFor(request, snapshot, prepared.bindingMode);
}

/**
 * Map any exception to a stable Adapter error. A raw provider exception or an
 * unknown object becomes the fallback code (default side-effect-unknown) with
 * the code-derived message; raw detail never escapes.
 */
export function toExternalAgentError(
	error: unknown,
	fallback: ExternalAgentErrorCode = "external_agent_side_effect_unknown",
): ExternalAgentError {
	if (error instanceof ExternalAgentError) return error;
	if (isRecord(error) && EXTERNAL_AGENT_ERROR_CODES.includes(error.code as ExternalAgentErrorCode)) {
		return new ExternalAgentError(error.code as ExternalAgentErrorCode);
	}
	return new ExternalAgentError(fallback);
}

const RECEIPT_ERROR_SIDE_EFFECTS: Readonly<Record<ExternalAgentErrorCode, RemoteOperationSideEffectState>> = {
	external_agent_adapter_invalid: "none",
	external_agent_target_not_found: "none",
	external_agent_probe_failed: "none",
	external_agent_protocol_unsupported: "none",
	external_agent_capability_missing: "none",
	external_agent_binding_unsupported: "none",
	external_agent_start_failed: "unknown",
	external_agent_mapping_invalid: "unknown",
	external_agent_mapping_conflict: "unknown",
	external_agent_cancel_unsupported: "unknown",
	external_agent_cancel_failed: "unknown",
	external_agent_receipt_invalid: "unknown",
	external_agent_side_effect_unknown: "unknown",
	external_agent_resume_unsupported: "none",
	external_agent_persistence_failed: "unknown",
};

/**
 * Side-effect-safe receipt error mapping. Codes that execute or may have
 * executed an external target default to `unknown` side effects; pre-flight
 * codes default to `none`. An explicit observed state overrides the default.
 */
export function toExternalAgentReceiptError(
	error: unknown,
	sideEffects?: RemoteOperationSideEffectState,
): ExternalAgentReceiptError {
	const agentError = toExternalAgentError(error);
	return Object.freeze({
		code: agentError.code,
		retryable: agentError.retryable,
		sideEffects: sideEffects ?? RECEIPT_ERROR_SIDE_EFFECTS[agentError.code],
	});
}

function safeNow(now: (() => string) | undefined): string {
	try {
		const value = now?.();
		if (value !== undefined && isCanonicalExternalMappingTimestamp(value)) return value;
	} catch {
		// The receipt clock is an implementation detail; use a canonical fallback.
	}
	return new Date().toISOString();
}

/**
 * Host-side driver for one external execution. It validates the start
 * request and the adapter identity exactly, forwards `adapter.start` with an
 * abortable context, validates and bounds every emitted event, enforces
 * idempotent cancel, and settles the receipt with stable failed semantics
 * for unverifiable outcomes:
 *
 * The returned handle also exposes `externalReady`: it resolves to the
 * validated external execution ref only after `start` returns and the
 * identity passes exact validation, and to `undefined` on start failure or
 * invalid identity. Run/RPC integration persists only this ref, never the
 * fallback identity, before `run.started`.
 *
 * - start failure -> failed + `external_agent_start_failed`, side effects
 *   unknown;
 * - invalid external identity -> failed + `external_agent_mapping_invalid`;
 * - missing, malformed, or identity-drifted receipt -> failed +
 *   `external_agent_receipt_invalid`;
 * - a `cancelled` receipt that still reports associated or unknown side
 *   effects (after cancel intent or not) -> failed +
 *   `external_agent_side_effect_unknown`, never `cancelled`;
 * - a target whose prepared binding declares `artifacts: false` never
 *   yields accepted artifact events (they are dropped like any other
 *   invalid observation), and a terminal receipt that claims `artifactRefs`
 *   anyway is invalid: failed + `external_agent_receipt_invalid` with the
 *   fabricated refs stripped, never forwarded.
 *
 * The driver never writes a Run terminal, Session entry, mapping, or ledger.
 */
export function runExternalAgentAdapter(
	adapter: ExternalAgentAdapter,
	request: ExternalAgentStartRequest,
	options: ExternalAgentRunOptions = {},
): ExternalAgentRunHandle {
	if (!isExternalAgentStartRequest(request)) {
		throw new ExternalAgentError("external_agent_adapter_invalid");
	}
	if (!isBoundedIdentifier(adapter.id, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) || adapter.id !== request.preparedBinding.adapterId) {
		throw new ExternalAgentError("external_agent_adapter_invalid");
	}
	const collector = createExternalAgentEventCollector({ maxEvents: clampEventLimit(options.maxEvents) });
	const controller = new AbortController();
	const fallbackExternal: ExternalExecutionRef = {
		namespace: "external-agent",
		externalSessionId: request.operationId,
	};
	let establishedExternal: ExternalExecutionRef = fallbackExternal;
	let adapterHandle: ExternalAgentHandle | undefined;
	let cancelRequested = false;
	let cancelFailed = false;
	let cancelAttempt: Promise<void> | undefined;
	let driftDropped = 0;
	let capabilityDropped = 0;
	let settled = false;
	let resolveStartGate: (() => void) | undefined;
	const startGate = new Promise<void>((resolve) => {
		resolveStartGate = resolve;
	});
	let resolveExternalReady: ((value: ExternalExecutionRef | undefined) => void) | undefined;
	const externalReady = new Promise<ExternalExecutionRef | undefined>((resolve) => {
		resolveExternalReady = resolve;
	});

	const forwardCancel = (): Promise<void> => {
		const handle = adapterHandle;
		if (handle === undefined || cancelAttempt !== undefined) return Promise.resolve();
		cancelAttempt = (async () => {
			try {
				await handle.cancel();
				cancelFailed = false;
			} catch {
				cancelFailed = true;
				// A failed attempt may be retried idempotently.
				cancelAttempt = undefined;
			}
		})();
		return cancelAttempt;
	};

	const requestCancel = async (): Promise<void> => {
		if (settled) return;
		cancelRequested = true;
		if (!controller.signal.aborted) controller.abort();
		if (adapterHandle === undefined) await startGate;
		if (settled) return;
		await forwardCancel();
		if (cancelFailed) throw new ExternalAgentError("external_agent_cancel_failed");
	};

	const onExternalAbort = (): void => {
		void requestCancel().catch(() => {
			// The abort path must not create an unhandled rejection; the
			// failure is observed through explicit cancel() calls.
		});
	};
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });

	const failureReceipt = (error: ExternalAgentError, external: ExternalExecutionRef): ExternalAgentReceipt => {
		const receiptError = toExternalAgentReceiptError(error);
		return Object.freeze({
			schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
			external: cloneExternalExecutionRef(external),
			status: "failed",
			endedAt: safeNow(options.now),
			artifactRefs: Object.freeze([]),
			sideEffects: receiptError.sideEffects,
			error: receiptError,
		});
	};

	const capabilities = request.preparedBinding.capabilities;

	const run = async (): Promise<ExternalAgentReceipt> => {
		try {
			let handle: ExternalAgentHandle;
			try {
				handle = await adapter.start(request, {
					signal: controller.signal,
					...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
				});
			} catch (error) {
				resolveStartGate?.();
				resolveExternalReady?.(undefined);
				return failureReceipt(toExternalAgentError(error, "external_agent_start_failed"), fallbackExternal);
			}
			adapterHandle = handle;
			resolveStartGate?.();
			if (cancelRequested) {
				try {
					await forwardCancel();
				} catch {
					// The cancel failure is recorded and surfaces on cancel().
				}
			}
			if (!isExternalExecutionRef(handle.external)) {
				resolveExternalReady?.(undefined);
				return failureReceipt(new ExternalAgentError("external_agent_mapping_invalid"), fallbackExternal);
			}
			establishedExternal = handle.external;
			resolveExternalReady?.(deepFreeze(cloneExternalExecutionRef(handle.external)));
			try {
				for await (const event of handle.events) {
					if (!isExternalAgentEvent(event)) {
						collector.push(event);
						continue;
					}
					if (!sameExternalRef(event.external, handle.external)) {
						driftDropped += 1;
						continue;
					}
					// Capability gate: the prepared binding declares whether artifact
					// facts are part of the contract. A target without the artifacts
					// capability cannot emit artifact observations; they are dropped
					// like any other invalid event, never accepted.
					if (event.type === "artifact" && !capabilities.artifacts) {
						capabilityDropped += 1;
						continue;
					}
					collector.push(event);
				}
			} catch {
				// An event stream failure never invents a terminal; the receipt stays authoritative.
			}
			let receipt: ExternalAgentReceipt;
			try {
				const value = await handle.receipt;
				if (!isExternalAgentReceipt(value)) {
					return failureReceipt(new ExternalAgentError("external_agent_receipt_invalid"), handle.external);
				}
				receipt = value;
			} catch {
				return failureReceipt(new ExternalAgentError("external_agent_receipt_invalid"), handle.external);
			}
			if (!sameExternalRef(receipt.external, handle.external)) {
				return failureReceipt(new ExternalAgentError("external_agent_receipt_invalid"), handle.external);
			}
			// A terminal that claims artifact refs for a target whose prepared
			// binding declares artifacts unsupported is invalid: fail closed with
			// the stable receipt error and strip the fabricated refs instead of
			// forwarding them. This runs before the cancelled rewrite so the rule
			// also covers cancelled terminals.
			if (!capabilities.artifacts && receipt.artifactRefs.length > 0) {
				return failureReceipt(new ExternalAgentError("external_agent_receipt_invalid"), handle.external);
			}
			if (receipt.status === "cancelled" && receipt.sideEffects !== "none") {
				return deepFreeze({
					...cloneExternalAgentReceipt(receipt),
					status: "failed",
					error: Object.freeze({
						code: "external_agent_side_effect_unknown",
						retryable: false,
						sideEffects: receipt.sideEffects,
					}),
				});
			}
			return cloneExternalAgentReceipt(receipt);
		} finally {
			settled = true;
			options.signal?.removeEventListener("abort", onExternalAbort);
		}
	};

	const receipt = run();

	return {
		externalReady,
		get external() {
			return establishedExternal;
		},
		events: {
			async *[Symbol.asyncIterator]() {
				for (const event of collector.events) yield event;
			},
		},
		get eventsList() {
			return collector.events;
		},
		get droppedEvents() {
			return collector.dropped + driftDropped + capabilityDropped;
		},
		receipt,
		cancel: () => requestCancel(),
		heartbeat: async () => {
			if (settled || request.lease === undefined) {
				throw new ExternalAgentError("external_agent_adapter_invalid");
			}
			if (adapterHandle === undefined) await startGate;
			if (settled || adapterHandle === undefined) {
				throw new ExternalAgentError("external_agent_adapter_invalid");
			}
			const refreshed = await adapterHandle.heartbeat();
			if (!isSafeLease(refreshed)) throw new ExternalAgentError("external_agent_adapter_invalid");
			return cloneLease(refreshed);
		},
	};
}
