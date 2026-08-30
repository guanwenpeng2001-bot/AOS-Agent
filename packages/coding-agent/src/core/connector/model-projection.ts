/**
 * External model projection and capability-truth gates.
 *
 * This module is a pure Host-side boundary. It projects an already resolved,
 * immutable AgentBinding for connectors that use the AOS model gateway and
 * proves that advertised connector capabilities have reachable handlers. It
 * does not select a connector, call a vendor driver, or activate a runtime.
 */

import {
	canonicalFoundationJson,
	fingerprintFoundationValue,
	validateImmutableAgentBinding,
	type AgentBinding,
	type Fingerprint,
} from "@aos-agent/agent-core";
import type { ModelFallbackReason } from "../runtime/model-broker.ts";

export const EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION = 1 as const;

export const EXTERNAL_MODEL_ACCESS_MODES = ["none", "agent_owned", "aos_gateway"] as const;
export type ExternalModelAccess = (typeof EXTERNAL_MODEL_ACCESS_MODES)[number];

export const EXTERNAL_MODEL_PROJECTION_FIELDS = [
	"provider",
	"model",
	"effort",
	"serviceTier",
	"fallbackDecision",
	"bindingDigest",
] as const;
export type ExternalModelProjectionField = (typeof EXTERNAL_MODEL_PROJECTION_FIELDS)[number];

export const EXTERNAL_CAPABILITY_BEHAVIORS = [
	"resume",
	"toolGateway",
	"artifacts",
	"images",
	"aosGateway",
] as const;
export type ExternalCapabilityBehavior = (typeof EXTERNAL_CAPABILITY_BEHAVIORS)[number];

export type ExternalProjectionErrorCode = "external_binding_invalid" | "external_capability_mismatch";
export type ExternalProjectionReasonCode =
	| "model_access_invalid"
	| "model_binding_required"
	| "model_binding_invalid"
	| "model_field_missing"
	| "model_fallback_invalid"
	| "model_support_matrix_invalid"
	| "model_field_unsupported"
	| "model_field_translation_failed"
	| "capability_snapshot_invalid"
	| "capability_evidence_missing"
	| "capability_evidence_unbound"
	| "capability_snapshot_drift";

export interface ExternalProjectionFailure {
	readonly ok: false;
	readonly status: "failed";
	readonly error: {
		readonly code: ExternalProjectionErrorCode;
		readonly reasonCode: ExternalProjectionReasonCode;
		readonly retryable: false;
		readonly field?: ExternalModelProjectionField | ExternalCapabilityBehavior;
	};
}

export type ExternalModelFallbackDecision =
	| { readonly kind: "disabled"; readonly reason: "fallback_disabled" }
	| { readonly kind: "primary"; readonly reason: "fallback_not_used" }
	| {
			readonly kind: "fallback";
			readonly reason: ModelFallbackReason;
			/** One-based index into the immutable AgentBinding fallback list. */
			readonly candidateIndex: number;
	  };

/** Canonical, secret-free resolved model facts delivered to a connector. */
export interface ExternalResolvedModelProjection {
	readonly schemaVersion: typeof EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION;
	readonly provider: string;
	readonly model: string;
	readonly effort: string;
	readonly serviceTier: string;
	readonly fallbackDecision: ExternalModelFallbackDecision;
	readonly bindingDigest: Fingerprint;
}

export interface ExternalModelBindingSource {
	/** Resolve the already persisted canonical AgentBinding. */
	resolve(): AgentBinding | Promise<AgentBinding>;
}

export interface ExternalModelProjectionGateInput {
	readonly modelAccess: ExternalModelAccess;
	readonly bindingSource?: ExternalModelBindingSource;
	readonly fallbackDecision?: ExternalModelFallbackDecision;
}

export type ExternalModelProjectionGateResult =
	| {
			readonly ok: true;
			readonly status: "not_required";
			readonly modelAccess: "none" | "agent_owned";
	  }
	| {
			readonly ok: true;
			readonly status: "projected";
			readonly modelAccess: "aos_gateway";
			readonly projection: ExternalResolvedModelProjection;
	  }
	| ExternalProjectionFailure;

export interface ExternalModelExactTranslation {
	readonly kind: "exact";
	readonly value: string;
}

export type ExternalModelFieldSupport =
	| { readonly supported: false }
	| {
			readonly supported: true;
			readonly targetField: string;
			/** Exact value support check. Returning false fails closed. */
			readonly accepts: (canonicalValue: string) => boolean;
			/** No default result exists: every accepted value must translate exactly. */
			readonly translate: (canonicalValue: string) => ExternalModelExactTranslation | undefined;
	  };

/** Open connector SPI: each connector supplies one entry for every canonical field. */
export type ExternalModelSupportMatrix = Readonly<Record<ExternalModelProjectionField, ExternalModelFieldSupport>>;

export interface ExternalTranslatedModelField {
	readonly targetField: string;
	readonly value: string;
}

export interface ExternalTranslatedModelProjection {
	readonly schemaVersion: typeof EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION;
	readonly sourceBindingDigest: Fingerprint;
	readonly fields: Readonly<Record<ExternalModelProjectionField, ExternalTranslatedModelField>>;
}

export type ExternalModelTranslationResult =
	| { readonly ok: true; readonly translation: ExternalTranslatedModelProjection }
	| ExternalProjectionFailure;

export interface ExternalCapabilityTruthFlags {
	readonly resume: boolean;
	readonly toolGateway: boolean;
	readonly artifacts: boolean;
	readonly images: boolean;
	readonly modelAccess: ExternalModelAccess;
}

export interface ExternalCapabilityBehaviorDeclaration {
	readonly id: string;
	readonly revision: number;
	readonly reachable: true;
}

export interface ExternalCapabilityHandlerEvidence {
	readonly id: string;
	/** The Host only proves reachability here; this gate never invokes the handler. */
	readonly invoke: (...args: never[]) => unknown;
}

export interface ExternalCapabilityBehaviorEvidenceInput {
	readonly declaration: ExternalCapabilityBehaviorDeclaration;
	readonly handler: ExternalCapabilityHandlerEvidence;
}

export type ExternalCapabilityEvidenceInput = Readonly<
	Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityBehaviorEvidenceInput>>
>;

export interface ExternalCapabilityBehaviorEvidence {
	readonly declarationId: string;
	readonly declarationRevision: number;
	readonly handlerId: string;
}

export interface ExternalCapabilityTruthSnapshotBase {
	readonly schemaVersion: typeof EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION;
	readonly connectorId: string;
	readonly protocol: string;
	readonly capabilityVersion: number;
	readonly capabilities: ExternalCapabilityTruthFlags;
	readonly evidence: Readonly<Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityBehaviorEvidence>>>;
}

export interface ExternalCapabilityTruthSnapshot extends ExternalCapabilityTruthSnapshotBase {
	readonly snapshotDigest: Fingerprint;
}

export interface ExternalCapabilityTruthInput {
	readonly connectorId: string;
	readonly protocol: string;
	readonly capabilityVersion: number;
	readonly capabilities: ExternalCapabilityTruthFlags;
	readonly evidence?: ExternalCapabilityEvidenceInput;
}

export type ExternalCapabilityTruthResult =
	| { readonly ok: true; readonly snapshot: ExternalCapabilityTruthSnapshot }
	| ExternalProjectionFailure;

export type ExternalCapabilityDriftPolicy = "reconcile_required" | "fail_closed";

export type ExternalCapabilitySnapshotDecision =
	| { readonly ok: true; readonly status: "accepted"; readonly snapshot: ExternalCapabilityTruthSnapshot }
	| {
			readonly ok: false;
			readonly status: "reconcile_required";
			readonly error: {
				readonly code: "external_capability_mismatch";
				readonly reasonCode: "capability_snapshot_drift";
				readonly retryable: false;
			};
	  }
	| ExternalProjectionFailure;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RESERVED_IMPLICIT_VALUE_PATTERN = /^(?:default|unknown)$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const PROJECTION_KEYS = new Set([
	"schemaVersion",
	"provider",
	"model",
	"effort",
	"serviceTier",
	"fallbackDecision",
	"bindingDigest",
]);
const FALLBACK_DISABLED_KEYS = new Set(["kind", "reason"]);
const FALLBACK_PRIMARY_KEYS = new Set(["kind", "reason"]);
const FALLBACK_SELECTED_KEYS = new Set(["kind", "reason", "candidateIndex"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const SUPPORT_MATRIX_KEYS = new Set(EXTERNAL_MODEL_PROJECTION_FIELDS);
const SUPPORT_DISABLED_KEYS = new Set(["supported"]);
const SUPPORT_EXACT_KEYS = new Set(["supported", "targetField", "accepts", "translate"]);
const TRUTH_INPUT_KEYS = new Set(["connectorId", "protocol", "capabilityVersion", "capabilities", "evidence"]);
const TRUTH_CAPABILITY_KEYS = new Set(["resume", "toolGateway", "artifacts", "images", "modelAccess"]);
const TRUTH_EVIDENCE_KEYS = new Set(EXTERNAL_CAPABILITY_BEHAVIORS);
const EVIDENCE_INPUT_KEYS = new Set(["declaration", "handler"]);
const DECLARATION_KEYS = new Set(["id", "revision", "reachable"]);
const HANDLER_KEYS = new Set(["id", "invoke"]);
const SNAPSHOT_KEYS = new Set([
	"schemaVersion",
	"connectorId",
	"protocol",
	"capabilityVersion",
	"capabilities",
	"evidence",
	"snapshotDigest",
]);
const SNAPSHOT_EVIDENCE_KEYS = new Set(["declarationId", "declarationRevision", "handlerId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
}

function failure(
	code: ExternalProjectionErrorCode,
	reasonCode: ExternalProjectionReasonCode,
	field?: ExternalModelProjectionField | ExternalCapabilityBehavior,
): ExternalProjectionFailure {
	return deepFreeze({
		ok: false,
		status: "failed",
		error: { code, reasonCode, retryable: false, ...(field === undefined ? {} : { field }) },
	});
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isExplicitValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		value.trim() === value &&
		!CONTROL_CHARACTER_PATTERN.test(value) &&
		!value.includes("://") &&
		!RESERVED_IMPLICIT_VALUE_PATTERN.test(value)
	);
}

function isExplicitTranslationValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		!CONTROL_CHARACTER_PATTERN.test(value) &&
		!RESERVED_IMPLICIT_VALUE_PATTERN.test(value)
	);
}

function isFingerprint(value: unknown): value is Fingerprint {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		DIGEST_PATTERN.test(value.value)
	);
}

export function isExternalModelFallbackDecision(value: unknown): value is ExternalModelFallbackDecision {
	if (!isRecord(value)) return false;
	if (value.kind === "disabled") {
		return hasOnlyKeys(value, FALLBACK_DISABLED_KEYS) && value.reason === "fallback_disabled";
	}
	if (value.kind === "primary") {
		return hasOnlyKeys(value, FALLBACK_PRIMARY_KEYS) && value.reason === "fallback_not_used";
	}
	return (
		value.kind === "fallback" &&
		hasOnlyKeys(value, FALLBACK_SELECTED_KEYS) &&
		(value.reason === "provider_unavailable" || value.reason === "transient_provider_error") &&
		typeof value.candidateIndex === "number" &&
		Number.isSafeInteger(value.candidateIndex) &&
		value.candidateIndex > 0
	);
}

function cloneFallbackDecision(value: ExternalModelFallbackDecision): ExternalModelFallbackDecision {
	if (value.kind === "disabled") return { kind: "disabled", reason: "fallback_disabled" };
	if (value.kind === "primary") return { kind: "primary", reason: "fallback_not_used" };
	return { kind: value.kind, reason: value.reason, candidateIndex: value.candidateIndex };
}

export function isExternalResolvedModelProjection(value: unknown): value is ExternalResolvedModelProjection {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, PROJECTION_KEYS) &&
		value.schemaVersion === EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION &&
		isExplicitValue(value.provider) &&
		isExplicitValue(value.model) &&
		isExplicitValue(value.effort) &&
		isExplicitValue(value.serviceTier) &&
		isExternalModelFallbackDecision(value.fallbackDecision) &&
		isFingerprint(value.bindingDigest)
	);
}

/**
 * Build a canonical projection from the immutable AgentBinding. Optional
 * effort/tier values are rejected: a connector may never fill them from a
 * vendor default. A fallback decision must point to the frozen fallback list.
 */
export function createExternalModelProjection(
	bindingValue: unknown,
	fallbackDecisionValue: unknown,
): { readonly ok: true; readonly projection: ExternalResolvedModelProjection } | ExternalProjectionFailure {
	const binding = validateImmutableAgentBinding(bindingValue);
	if (!binding.ok) return failure("external_binding_invalid", "model_binding_invalid");
	if (!isExternalModelFallbackDecision(fallbackDecisionValue)) {
		return failure("external_binding_invalid", "model_fallback_invalid", "fallbackDecision");
	}
	const route = binding.value.modelRoute;
	if (!isExplicitValue(route.provider)) return failure("external_binding_invalid", "model_field_missing", "provider");
	if (!isExplicitValue(route.model)) return failure("external_binding_invalid", "model_field_missing", "model");
	if (!isExplicitValue(route.effort)) return failure("external_binding_invalid", "model_field_missing", "effort");
	if (!isExplicitValue(route.serviceTier)) {
		return failure("external_binding_invalid", "model_field_missing", "serviceTier");
	}

	let provider = route.provider;
	let model = route.model;
	if (fallbackDecisionValue.kind === "fallback") {
		const candidate = route.fallback?.[fallbackDecisionValue.candidateIndex - 1];
		if (candidate === undefined || !isExplicitValue(candidate.provider) || !isExplicitValue(candidate.model)) {
			return failure("external_binding_invalid", "model_fallback_invalid", "fallbackDecision");
		}
		provider = candidate.provider;
		model = candidate.model;
	}

	return {
		ok: true,
		projection: deepFreeze({
			schemaVersion: EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION,
			provider,
			model,
			effort: route.effort,
			serviceTier: route.serviceTier,
			fallbackDecision: cloneFallbackDecision(fallbackDecisionValue),
			bindingDigest: { algorithm: "sha256", value: binding.value.fingerprint.value },
		}),
	};
}

/**
 * Execution-class-aware model gate. The binding source is intentionally not
 * inspected for `none` or `agent_owned`, so external-only operation never
 * performs local model preflight. `aos_gateway` resolves exactly once.
 */
export async function projectExternalModelForExecution(
	input: ExternalModelProjectionGateInput,
): Promise<ExternalModelProjectionGateResult> {
	if (input.modelAccess === "none" || input.modelAccess === "agent_owned") {
		return deepFreeze({ ok: true, status: "not_required", modelAccess: input.modelAccess });
	}
	if (input.modelAccess !== "aos_gateway") {
		return failure("external_capability_mismatch", "model_access_invalid");
	}
	if (input.bindingSource === undefined || input.fallbackDecision === undefined) {
		return failure("external_binding_invalid", "model_binding_required");
	}
	let binding: AgentBinding;
	try {
		binding = await input.bindingSource.resolve();
	} catch {
		return failure("external_binding_invalid", "model_binding_invalid");
	}
	const projected = createExternalModelProjection(binding, input.fallbackDecision);
	if (!projected.ok) return projected;
	return deepFreeze({ ok: true, status: "projected", modelAccess: "aos_gateway", projection: projected.projection });
}

function canonicalProjectionFieldValue(
	projection: ExternalResolvedModelProjection,
	field: ExternalModelProjectionField,
): string {
	if (field === "fallbackDecision") return canonicalFoundationJson(projection.fallbackDecision);
	if (field === "bindingDigest") return canonicalFoundationJson(projection.bindingDigest);
	return projection[field];
}

function isSupportMatrix(value: unknown): value is ExternalModelSupportMatrix {
	if (!isRecord(value) || !hasOnlyKeys(value, SUPPORT_MATRIX_KEYS)) return false;
	if (Object.keys(value).length !== EXTERNAL_MODEL_PROJECTION_FIELDS.length) return false;
	return EXTERNAL_MODEL_PROJECTION_FIELDS.every((field) => {
		const support = value[field];
		if (!isRecord(support) || typeof support.supported !== "boolean") return false;
		if (!support.supported) return hasOnlyKeys(support, SUPPORT_DISABLED_KEYS);
		return (
			hasOnlyKeys(support, SUPPORT_EXACT_KEYS) &&
			isSafeIdentifier(support.targetField) &&
			typeof support.accepts === "function" &&
			typeof support.translate === "function"
		);
	});
}

export function isExternalTranslatedModelProjection(value: unknown): value is ExternalTranslatedModelProjection {
	if (
		!isRecord(value) ||
		value.schemaVersion !== EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION ||
		!isFingerprint(value.sourceBindingDigest) ||
		!isRecord(value.fields) ||
		!hasOnlyKeys(value, new Set(["schemaVersion", "sourceBindingDigest", "fields"])) ||
		!hasOnlyKeys(value.fields, SUPPORT_MATRIX_KEYS) ||
		Object.keys(value.fields).length !== EXTERNAL_MODEL_PROJECTION_FIELDS.length
	) {
		return false;
	}
	const targets = new Set<string>();
	for (const field of EXTERNAL_MODEL_PROJECTION_FIELDS) {
		const translated = value.fields[field];
		if (
			!isRecord(translated) ||
			!hasOnlyKeys(translated, new Set(["targetField", "value"])) ||
			!isSafeIdentifier(translated.targetField) ||
			!isExplicitTranslationValue(translated.value) ||
			targets.has(translated.targetField)
		) {
			return false;
		}
		targets.add(translated.targetField);
	}
	return true;
}

/** Translate every canonical field exactly; one missing/unsupported field rejects the whole projection. */
export function translateExternalModelProjection(
	projectionValue: unknown,
	matrixValue: unknown,
): ExternalModelTranslationResult {
	if (!isExternalResolvedModelProjection(projectionValue)) {
		return failure("external_binding_invalid", "model_binding_invalid");
	}
	if (!isSupportMatrix(matrixValue)) {
		return failure("external_binding_invalid", "model_support_matrix_invalid");
	}

	const fields = {} as Record<ExternalModelProjectionField, ExternalTranslatedModelField>;
	const targetFields = new Set<string>();
	for (const field of EXTERNAL_MODEL_PROJECTION_FIELDS) {
		const support = matrixValue[field];
		if (!support.supported) {
			return failure("external_binding_invalid", "model_field_unsupported", field);
		}
		if (targetFields.has(support.targetField)) {
			return failure("external_binding_invalid", "model_support_matrix_invalid", field);
		}
		const value = canonicalProjectionFieldValue(projectionValue, field);
		let accepted = false;
		let translated: ExternalModelExactTranslation | undefined;
		try {
			accepted = support.accepts(value);
			if (accepted) translated = support.translate(value);
		} catch {
			return failure("external_binding_invalid", "model_field_translation_failed", field);
		}
		if (!accepted) return failure("external_binding_invalid", "model_field_unsupported", field);
		if (
			translated === undefined ||
			translated.kind !== "exact" ||
			!isExplicitTranslationValue(translated.value) ||
			Object.keys(translated).some((key) => key !== "kind" && key !== "value")
		) {
			return failure("external_binding_invalid", "model_field_translation_failed", field);
		}
		targetFields.add(support.targetField);
		fields[field] = { targetField: support.targetField, value: translated.value };
	}

	return {
		ok: true,
		translation: deepFreeze({
			schemaVersion: EXTERNAL_MODEL_PROJECTION_SCHEMA_VERSION,
			sourceBindingDigest: { ...projectionValue.bindingDigest },
			fields,
		}),
	};
}

function isTruthCapabilities(value: unknown): value is ExternalCapabilityTruthFlags {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, TRUTH_CAPABILITY_KEYS) &&
		Object.keys(value).length === TRUTH_CAPABILITY_KEYS.size &&
		typeof value.resume === "boolean" &&
		typeof value.toolGateway === "boolean" &&
		typeof value.artifacts === "boolean" &&
		typeof value.images === "boolean" &&
		EXTERNAL_MODEL_ACCESS_MODES.includes(value.modelAccess as ExternalModelAccess)
	);
}

function isEvidenceInput(value: unknown): value is ExternalCapabilityBehaviorEvidenceInput {
	if (!isRecord(value) || !hasOnlyKeys(value, EVIDENCE_INPUT_KEYS)) return false;
	if (!isRecord(value.declaration) || !hasOnlyKeys(value.declaration, DECLARATION_KEYS)) return false;
	if (!isRecord(value.handler) || !hasOnlyKeys(value.handler, HANDLER_KEYS)) return false;
	return (
		isSafeIdentifier(value.declaration.id) &&
		typeof value.declaration.revision === "number" &&
		Number.isSafeInteger(value.declaration.revision) &&
		value.declaration.revision >= 1 &&
		value.declaration.reachable === true &&
		isSafeIdentifier(value.handler.id) &&
		typeof value.handler.invoke === "function"
	);
}

function requiredBehavior(capabilities: ExternalCapabilityTruthFlags, behavior: ExternalCapabilityBehavior): boolean {
	if (behavior === "aosGateway") return capabilities.modelAccess === "aos_gateway";
	return capabilities[behavior];
}

function isTruthInput(value: unknown): value is ExternalCapabilityTruthInput {
	if (!isRecord(value) || !hasOnlyKeys(value, TRUTH_INPUT_KEYS)) return false;
	if (!isSafeIdentifier(value.connectorId) || !isSafeIdentifier(value.protocol)) return false;
	if (
		typeof value.capabilityVersion !== "number" ||
		!Number.isSafeInteger(value.capabilityVersion) ||
		value.capabilityVersion < 1
	) {
		return false;
	}
	if (!isTruthCapabilities(value.capabilities)) return false;
	if (value.evidence === undefined) return true;
	if (!isRecord(value.evidence) || !hasOnlyKeys(value.evidence, TRUTH_EVIDENCE_KEYS)) return false;
	return Object.values(value.evidence).every(isEvidenceInput);
}

export function createExternalCapabilitySnapshotDigest(base: ExternalCapabilityTruthSnapshotBase): Fingerprint {
	return fingerprintFoundationValue(base);
}

/** Bind every true capability to a trusted, reachable declaration and handler. */
export function createExternalCapabilityTruthSnapshot(inputValue: unknown): ExternalCapabilityTruthResult {
	if (!isTruthInput(inputValue)) return failure("external_capability_mismatch", "capability_snapshot_invalid");
	const evidence: Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityBehaviorEvidence>> = {};
	for (const behavior of EXTERNAL_CAPABILITY_BEHAVIORS) {
		const required = requiredBehavior(inputValue.capabilities, behavior);
		const supplied = inputValue.evidence?.[behavior];
		if (required && supplied === undefined) {
			return failure("external_capability_mismatch", "capability_evidence_missing", behavior);
		}
		if (!required && supplied !== undefined) {
			return failure("external_capability_mismatch", "capability_evidence_unbound", behavior);
		}
		if (supplied !== undefined) {
			evidence[behavior] = {
				declarationId: supplied.declaration.id,
				declarationRevision: supplied.declaration.revision,
				handlerId: supplied.handler.id,
			};
		}
	}

	const base: ExternalCapabilityTruthSnapshotBase = {
		schemaVersion: EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION,
		connectorId: inputValue.connectorId,
		protocol: inputValue.protocol,
		capabilityVersion: inputValue.capabilityVersion,
		capabilities: { ...inputValue.capabilities },
		evidence,
	};
	return {
		ok: true,
		snapshot: deepFreeze({ ...base, snapshotDigest: createExternalCapabilitySnapshotDigest(base) }),
	};
}

function isSnapshotEvidence(value: unknown): value is ExternalCapabilityBehaviorEvidence {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, SNAPSHOT_EVIDENCE_KEYS) &&
		isSafeIdentifier(value.declarationId) &&
		typeof value.declarationRevision === "number" &&
		Number.isSafeInteger(value.declarationRevision) &&
		value.declarationRevision >= 1 &&
		isSafeIdentifier(value.handlerId)
	);
}

export function validateExternalCapabilityTruthSnapshot(value: unknown): value is ExternalCapabilityTruthSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return false;
	if (value.schemaVersion !== EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.connectorId) || !isSafeIdentifier(value.protocol)) return false;
	if (
		typeof value.capabilityVersion !== "number" ||
		!Number.isSafeInteger(value.capabilityVersion) ||
		value.capabilityVersion < 1 ||
		!isTruthCapabilities(value.capabilities) ||
		!isRecord(value.evidence) ||
		!hasOnlyKeys(value.evidence, TRUTH_EVIDENCE_KEYS) ||
		!Object.values(value.evidence).every(isSnapshotEvidence) ||
		!isFingerprint(value.snapshotDigest)
	) {
		return false;
	}
	for (const behavior of EXTERNAL_CAPABILITY_BEHAVIORS) {
		if (requiredBehavior(value.capabilities, behavior) !== (value.evidence[behavior] !== undefined)) return false;
	}
	const base: ExternalCapabilityTruthSnapshotBase = {
		schemaVersion: EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION,
		connectorId: value.connectorId,
		protocol: value.protocol,
		capabilityVersion: value.capabilityVersion,
		capabilities: value.capabilities,
		evidence: value.evidence,
	};
	return createExternalCapabilitySnapshotDigest(base).value === value.snapshotDigest.value;
}

function cloneTruthSnapshot(value: ExternalCapabilityTruthSnapshot): ExternalCapabilityTruthSnapshot {
	const evidence: Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityBehaviorEvidence>> = {};
	for (const behavior of EXTERNAL_CAPABILITY_BEHAVIORS) {
		const item = value.evidence[behavior];
		if (item !== undefined) evidence[behavior] = { ...item };
	}
	return deepFreeze({
		schemaVersion: EXTERNAL_CAPABILITY_TRUTH_SCHEMA_VERSION,
		connectorId: value.connectorId,
		protocol: value.protocol,
		capabilityVersion: value.capabilityVersion,
		capabilities: { ...value.capabilities },
		evidence,
		snapshotDigest: { ...value.snapshotDigest },
	});
}

/** Compare the pinned Attempt digest with a newly observed truth snapshot. */
export function decideExternalCapabilitySnapshot(
	expectedDigest: unknown,
	observedSnapshot: unknown,
	driftPolicy: ExternalCapabilityDriftPolicy = "reconcile_required",
): ExternalCapabilitySnapshotDecision {
	if (!isFingerprint(expectedDigest) || !validateExternalCapabilityTruthSnapshot(observedSnapshot)) {
		return failure("external_capability_mismatch", "capability_snapshot_invalid");
	}
	if (expectedDigest.value === observedSnapshot.snapshotDigest.value) {
		return { ok: true, status: "accepted", snapshot: cloneTruthSnapshot(observedSnapshot) };
	}
	if (driftPolicy === "reconcile_required") {
		return deepFreeze({
			ok: false,
			status: "reconcile_required",
			error: {
				code: "external_capability_mismatch",
				reasonCode: "capability_snapshot_drift",
				retryable: false,
			},
		});
	}
	return failure("external_capability_mismatch", "capability_snapshot_drift");
}
