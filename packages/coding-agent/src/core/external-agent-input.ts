import {
	type ArtifactDigest,
	type ArtifactRef,
	artifactDigestFromId,
	canonicalFoundationJson,
	fingerprintFoundationValue,
	isValidArtifactDigest,
	isValidArtifactId,
	validateArtifactRef,
} from "@aos-agent/agent-core";

export const CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION = 1 as const;

export const CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS = Object.freeze({
	maxTextBytes: 256 * 1024,
	maxArtifacts: 64,
	maxImages: 8,
	maxArtifactBytes: 32 * 1024 * 1024,
	maxTotalArtifactBytes: 128 * 1024 * 1024,
});

export type CanonicalExternalAgentArtifactKind = "file" | "image";
export type CanonicalExternalAgentArtifactSource = "artifact_store" | "workspace";

export interface CanonicalExternalAgentArtifactProvenance {
	readonly source: CanonicalExternalAgentArtifactSource;
	readonly producer: string;
	readonly trust: "trusted";
}

export type CanonicalExternalAgentArtifactReadHandle =
	| {
			readonly kind: "artifact_store";
			/** Content-addressed Artifact Store identity, never a local path or URL. */
			readonly ref: string;
	  }
	| {
			readonly kind: "workspace_relative";
			/** Opaque identity of the workspace whose authority will resolve the path. */
			readonly workspaceId: string;
			/** Canonical `/`-separated relative path. The Connector must not resolve it itself. */
			readonly relativePath: string;
			/** Opaque Host-owned read handle bound to the workspace-relative path. */
			readonly ref: string;
	  };

/**
 * Metadata-only Artifact input. It refines the Foundation ArtifactRef by
 * requiring size and producer provenance, then adds a constrained read handle.
 */
export interface CanonicalExternalAgentArtifactReference {
	readonly schemaVersion: typeof CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION;
	readonly artifactId: string;
	readonly kind: CanonicalExternalAgentArtifactKind;
	readonly digest: ArtifactDigest;
	readonly mediaType: string;
	readonly sizeBytes: number;
	readonly provenance: CanonicalExternalAgentArtifactProvenance;
	readonly readHandle: CanonicalExternalAgentArtifactReadHandle;
}

/** The only business input shape that may cross an External Connector boundary. */
export interface CanonicalExternalAgentInput {
	readonly schemaVersion: typeof CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION;
	readonly text: string;
	readonly artifacts: readonly CanonicalExternalAgentArtifactReference[];
}

export type CanonicalExternalAgentRequestFingerprint = `sha256:${string}`;

export const EXTERNAL_AGENT_INPUT_ERROR_CODES = [
	"external_binding_invalid",
	"external_capability_mismatch",
	"external_resource_limit_exceeded",
	"external_path_outside_workspace",
] as const;

export type ExternalAgentInputErrorCode = (typeof EXTERNAL_AGENT_INPUT_ERROR_CODES)[number];

export const EXTERNAL_AGENT_INPUT_REASON_CODES = [
	"input_invalid",
	"unsafe_reference",
	"untrusted_artifact",
	"digest_mismatch",
	"reference_mismatch",
	"verification_failed",
	"input_capability_unsupported",
	"input_oversize",
	"input_workspace_escape",
] as const;

export type ExternalAgentInputReasonCode = (typeof EXTERNAL_AGENT_INPUT_REASON_CODES)[number];

const ERROR_CODE_BY_REASON = {
	input_invalid: "external_binding_invalid",
	unsafe_reference: "external_binding_invalid",
	untrusted_artifact: "external_binding_invalid",
	digest_mismatch: "external_binding_invalid",
	reference_mismatch: "external_binding_invalid",
	verification_failed: "external_binding_invalid",
	input_capability_unsupported: "external_capability_mismatch",
	input_oversize: "external_resource_limit_exceeded",
	input_workspace_escape: "external_path_outside_workspace",
} as const satisfies Record<ExternalAgentInputReasonCode, ExternalAgentInputErrorCode>;

const ERROR_MESSAGES = {
	external_binding_invalid: "External Agent input binding is invalid",
	external_capability_mismatch: "External Agent input capability is unsupported",
	external_resource_limit_exceeded: "External Agent input exceeds resource limits",
	external_path_outside_workspace: "External Agent input is outside its workspace",
} as const satisfies Record<ExternalAgentInputErrorCode, string>;

export class ExternalAgentInputError extends Error {
	readonly code: ExternalAgentInputErrorCode;
	readonly reasonCode: ExternalAgentInputReasonCode;
	readonly retryable: false;

	constructor(reasonCode: ExternalAgentInputReasonCode) {
		const code = ERROR_CODE_BY_REASON[reasonCode];
		super(ERROR_MESSAGES[code]);
		Object.defineProperty(this, "name", { configurable: true, value: "ExternalAgentInputError" });
		this.code = code;
		this.reasonCode = reasonCode;
		this.retryable = false;
	}
}

export type ExternalAgentInputValidationResult =
	| { readonly ok: true; readonly value: CanonicalExternalAgentInput }
	| { readonly ok: false; readonly error: ExternalAgentInputError };

export interface ExternalAgentInputCapabilities {
	readonly artifacts: boolean;
	readonly images: boolean;
}

export interface ExternalAgentInputLimits {
	readonly maxTextBytes: number;
	readonly maxArtifacts: number;
	readonly maxImages: number;
	readonly maxArtifactBytes: number;
	readonly maxTotalArtifactBytes: number;
}

/** Metadata returned by a trusted, read-only Host Artifact authority. */
export interface ExternalAgentArtifactInspection {
	readonly artifactId: string;
	readonly ref: string;
	readonly digest: ArtifactDigest;
	readonly mediaType: string;
	readonly sizeBytes: number;
	readonly trusted: boolean;
	readonly workspaceContained: boolean;
}

export interface ExternalAgentInputAdmissionOptions {
	readonly capabilities: ExternalAgentInputCapabilities;
	readonly limits?: Partial<ExternalAgentInputLimits>;
	inspectArtifact(
		reference: CanonicalExternalAgentArtifactReference,
	): ExternalAgentArtifactInspection | Promise<ExternalAgentArtifactInspection>;
}

export type ExternalAgentInputAdmissionResult =
	| {
			readonly ok: true;
			readonly input: CanonicalExternalAgentInput;
			readonly requestFingerprint: CanonicalExternalAgentRequestFingerprint;
	  }
	| { readonly ok: false; readonly error: ExternalAgentInputError };

const INPUT_KEYS = new Set(["schemaVersion", "text", "artifacts"]);
const ARTIFACT_KEYS = new Set([
	"schemaVersion",
	"artifactId",
	"kind",
	"digest",
	"mediaType",
	"sizeBytes",
	"provenance",
	"readHandle",
]);
const PROVENANCE_KEYS = new Set(["source", "producer", "trust"]);
const ARTIFACT_STORE_HANDLE_KEYS = new Set(["kind", "ref"]);
const WORKSPACE_HANDLE_KEYS = new Set(["kind", "workspaceId", "relativePath", "ref"]);
const CAPABILITY_KEYS = new Set(["artifacts", "images"]);
const LIMIT_KEYS = new Set(["maxTextBytes", "maxArtifacts", "maxImages", "maxArtifactBytes", "maxTotalArtifactBytes"]);
const INSPECTION_KEYS = new Set([
	"artifactId",
	"ref",
	"digest",
	"mediaType",
	"sizeBytes",
	"trusted",
	"workspaceContained",
]);
const UNSAFE_REFERENCE_KEYS = new Set(["bytes", "content", "data", "raw", "url", "uri", "absolutePath", "targetPath"]);
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SAFE_MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function inputError(reasonCode: ExternalAgentInputReasonCode): ExternalAgentInputError {
	return new ExternalAgentInputError(reasonCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	required: ReadonlySet<string>,
): boolean {
	const keys = Reflect.ownKeys(value);
	return (
		keys.every((key) => typeof key === "string" && allowed.has(key)) &&
		[...required].every((key) => Object.hasOwn(value, key))
	);
}

function hasUnsafeReferenceField(value: Record<string, unknown>): boolean {
	return Object.keys(value).some((key) => UNSAFE_REFERENCE_KEYS.has(key));
}

function isSafeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && SAFE_OPAQUE_ID_PATTERN.test(value);
}

function isSafeMediaType(value: unknown): value is string {
	return typeof value === "string" && SAFE_MEDIA_TYPE_PATTERN.test(value);
}

function isCanonicalWorkspaceRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
	if (
		value.startsWith("/") ||
		value.startsWith("\\") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes(":") ||
		value.includes("%") ||
		WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
	) {
		return false;
	}
	const segments = value.split("/");
	return segments.every(
		(segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/[\u0000-\u001f\u007f]/.test(segment),
	);
}

function cloneReadHandle(
	value: unknown,
	provenanceSource: CanonicalExternalAgentArtifactSource,
	artifactId: string,
): CanonicalExternalAgentArtifactReadHandle {
	if (!isRecord(value)) throw inputError("input_invalid");
	if (hasUnsafeReferenceField(value)) throw inputError("unsafe_reference");
	if (value.kind === "artifact_store") {
		if (
			!hasExactKeys(value, ARTIFACT_STORE_HANDLE_KEYS, ARTIFACT_STORE_HANDLE_KEYS) ||
			provenanceSource !== "artifact_store" ||
			!isSafeOpaqueId(value.ref) ||
			value.ref !== artifactId
		) {
			throw inputError("reference_mismatch");
		}
		return Object.freeze({ kind: "artifact_store", ref: value.ref });
	}
	if (value.kind === "workspace_relative") {
		if (!hasExactKeys(value, WORKSPACE_HANDLE_KEYS, WORKSPACE_HANDLE_KEYS)) {
			throw inputError("input_invalid");
		}
		if (provenanceSource !== "workspace") {
			throw inputError("reference_mismatch");
		}
		if (!isCanonicalWorkspaceRelativePath(value.relativePath)) {
			throw inputError("input_workspace_escape");
		}
		if (!isSafeOpaqueId(value.workspaceId) || !isSafeOpaqueId(value.ref)) {
			throw inputError("unsafe_reference");
		}
		return Object.freeze({
			kind: "workspace_relative",
			workspaceId: value.workspaceId,
			relativePath: value.relativePath,
			ref: value.ref,
		});
	}
	throw inputError("unsafe_reference");
}

function cloneProvenance(value: unknown): CanonicalExternalAgentArtifactProvenance {
	if (!isRecord(value) || !hasExactKeys(value, PROVENANCE_KEYS, PROVENANCE_KEYS)) {
		throw inputError("input_invalid");
	}
	if (value.trust !== "trusted") throw inputError("untrusted_artifact");
	if (value.source !== "artifact_store" && value.source !== "workspace") {
		throw inputError("unsafe_reference");
	}
	if (!isSafeOpaqueId(value.producer)) throw inputError("unsafe_reference");
	return Object.freeze({ source: value.source, producer: value.producer, trust: "trusted" });
}

function cloneArtifactReference(value: unknown): CanonicalExternalAgentArtifactReference {
	if (!isRecord(value)) throw inputError("input_invalid");
	if (hasUnsafeReferenceField(value)) throw inputError("unsafe_reference");
	if (!hasExactKeys(value, ARTIFACT_KEYS, ARTIFACT_KEYS)) throw inputError("input_invalid");
	if (value.schemaVersion !== CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION) {
		throw inputError("input_invalid");
	}
	if (typeof value.artifactId !== "string" || !isValidArtifactId(value.artifactId)) {
		throw inputError("input_invalid");
	}
	const artifactId = value.artifactId;
	if (
		typeof value.digest !== "string" ||
		!isValidArtifactDigest(value.digest) ||
		value.digest !== artifactDigestFromId(artifactId)
	) {
		throw inputError("digest_mismatch");
	}
	if (value.kind !== "file" && value.kind !== "image") throw inputError("input_invalid");
	if (!isSafeMediaType(value.mediaType)) throw inputError("input_invalid");
	if ((value.kind === "image") !== value.mediaType.startsWith("image/")) {
		throw inputError("reference_mismatch");
	}
	if (typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
		throw inputError("input_invalid");
	}
	const provenance = cloneProvenance(value.provenance);
	const foundationReference: ArtifactRef = {
		schemaVersion: 1,
		artifactId,
		digest: value.digest,
		mediaType: value.mediaType,
		producer: provenance.producer,
		sizeBytes: value.sizeBytes,
	};
	if (!validateArtifactRef(foundationReference).ok) throw inputError("input_invalid");
	return Object.freeze({
		schemaVersion: CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION,
		artifactId,
		kind: value.kind,
		digest: value.digest,
		mediaType: value.mediaType,
		sizeBytes: value.sizeBytes,
		provenance,
		readHandle: cloneReadHandle(value.readHandle, provenance.source, artifactId),
	});
}

function cloneInput(value: unknown): CanonicalExternalAgentInput {
	if (!isRecord(value) || hasUnsafeReferenceField(value) || !hasExactKeys(value, INPUT_KEYS, INPUT_KEYS)) {
		throw inputError("input_invalid");
	}
	if (value.schemaVersion !== CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION || typeof value.text !== "string") {
		throw inputError("input_invalid");
	}
	const textBytes = new TextEncoder().encode(value.text).byteLength;
	if (textBytes === 0 || value.text.includes("\0")) throw inputError("input_invalid");
	if (textBytes > CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxTextBytes) {
		throw inputError("input_oversize");
	}
	if (!Array.isArray(value.artifacts)) throw inputError("input_invalid");
	if (value.artifacts.length > CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxArtifacts) {
		throw inputError("input_oversize");
	}
	const artifacts = value.artifacts.map(cloneArtifactReference);
	if (
		artifacts.filter((artifact) => artifact.kind === "image").length >
		CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxImages
	) {
		throw inputError("input_oversize");
	}
	const clone = Object.freeze({
		schemaVersion: CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION,
		text: value.text,
		artifacts: Object.freeze(artifacts),
	});
	canonicalFoundationJson(clone);
	return clone;
}

export function validateCanonicalExternalAgentInput(value: unknown): ExternalAgentInputValidationResult {
	try {
		return { ok: true, value: cloneInput(value) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof ExternalAgentInputError ? error : inputError("input_invalid"),
		};
	}
}

export function isCanonicalExternalAgentInput(value: unknown): value is CanonicalExternalAgentInput {
	return validateCanonicalExternalAgentInput(value).ok;
}

export function cloneCanonicalExternalAgentInput(value: unknown): CanonicalExternalAgentInput {
	const checked = validateCanonicalExternalAgentInput(value);
	if (!checked.ok) throw checked.error;
	return checked.value;
}

export function serializeCanonicalExternalAgentInput(value: unknown): string {
	return canonicalFoundationJson(cloneCanonicalExternalAgentInput(value));
}

export function parseCanonicalExternalAgentInput(text: string): ExternalAgentInputValidationResult {
	try {
		return validateCanonicalExternalAgentInput(JSON.parse(text) as unknown);
	} catch {
		return { ok: false, error: inputError("input_invalid") };
	}
}

export function fingerprintCanonicalExternalAgentInput(value: unknown): CanonicalExternalAgentRequestFingerprint {
	const clone = cloneCanonicalExternalAgentInput(value);
	return `sha256:${fingerprintFoundationValue(clone).value}`;
}

function cloneCapabilities(value: unknown): ExternalAgentInputCapabilities {
	if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS, CAPABILITY_KEYS)) {
		throw inputError("input_invalid");
	}
	if (
		typeof value.artifacts !== "boolean" ||
		typeof value.images !== "boolean" ||
		(value.images && !value.artifacts)
	) {
		throw inputError("input_invalid");
	}
	return { artifacts: value.artifacts, images: value.images };
}

function resolveLimits(value: unknown): ExternalAgentInputLimits {
	if (value !== undefined && (!isRecord(value) || !hasExactKeys(value, LIMIT_KEYS, new Set()))) {
		throw inputError("input_invalid");
	}
	const supplied = value as Partial<Record<keyof ExternalAgentInputLimits, unknown>> | undefined;
	const limits: ExternalAgentInputLimits = {
		maxTextBytes:
			(supplied?.maxTextBytes as number | undefined) ?? CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxTextBytes,
		maxArtifacts:
			(supplied?.maxArtifacts as number | undefined) ?? CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxArtifacts,
		maxImages: (supplied?.maxImages as number | undefined) ?? CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxImages,
		maxArtifactBytes:
			(supplied?.maxArtifactBytes as number | undefined) ??
			CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxArtifactBytes,
		maxTotalArtifactBytes:
			(supplied?.maxTotalArtifactBytes as number | undefined) ??
			CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS.maxTotalArtifactBytes,
	};
	for (const key of LIMIT_KEYS as Set<keyof ExternalAgentInputLimits>) {
		const limit = limits[key];
		if (!Number.isSafeInteger(limit) || limit < 0 || limit > CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS[key]) {
			throw inputError("input_invalid");
		}
	}
	return limits;
}

function cloneInspection(value: unknown): ExternalAgentArtifactInspection {
	if (!isRecord(value) || !hasExactKeys(value, INSPECTION_KEYS, INSPECTION_KEYS)) {
		throw inputError("verification_failed");
	}
	if (
		typeof value.artifactId !== "string" ||
		!isValidArtifactId(value.artifactId) ||
		!isSafeOpaqueId(value.ref) ||
		typeof value.digest !== "string" ||
		!isValidArtifactDigest(value.digest) ||
		!isSafeMediaType(value.mediaType) ||
		typeof value.sizeBytes !== "number" ||
		!Number.isSafeInteger(value.sizeBytes) ||
		value.sizeBytes < 0 ||
		typeof value.trusted !== "boolean" ||
		typeof value.workspaceContained !== "boolean"
	) {
		throw inputError("verification_failed");
	}
	return {
		artifactId: value.artifactId,
		ref: value.ref,
		digest: value.digest,
		mediaType: value.mediaType,
		sizeBytes: value.sizeBytes,
		trusted: value.trusted,
		workspaceContained: value.workspaceContained,
	};
}

function rejection(error: unknown): ExternalAgentInputAdmissionResult {
	return {
		ok: false,
		error: error instanceof ExternalAgentInputError ? error : inputError("verification_failed"),
	};
}

/**
 * Read-only admission gate. Callers may persist an accepted fact or invoke a
 * Connector only after this returns `ok: true`; every reject returns before
 * any Connector callback exists in this boundary.
 */
export async function gateCanonicalExternalAgentInputBeforeAcceptance(
	value: unknown,
	options: ExternalAgentInputAdmissionOptions,
): Promise<ExternalAgentInputAdmissionResult> {
	const checked = validateCanonicalExternalAgentInput(value);
	if (!checked.ok) return checked;
	let capabilities: ExternalAgentInputCapabilities;
	let limits: ExternalAgentInputLimits;
	try {
		capabilities = cloneCapabilities(options.capabilities);
		limits = resolveLimits(options.limits);
	} catch (error) {
		return rejection(error);
	}
	const input = checked.value;
	const textBytes = new TextEncoder().encode(input.text).byteLength;
	const imageCount = input.artifacts.filter((artifact) => artifact.kind === "image").length;
	if ((input.artifacts.length > 0 && !capabilities.artifacts) || (imageCount > 0 && !capabilities.images)) {
		return rejection(inputError("input_capability_unsupported"));
	}
	if (
		textBytes > limits.maxTextBytes ||
		input.artifacts.length > limits.maxArtifacts ||
		imageCount > limits.maxImages ||
		input.artifacts.some((artifact) => artifact.sizeBytes > limits.maxArtifactBytes)
	) {
		return rejection(inputError("input_oversize"));
	}
	const claimedTotal = input.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
	if (!Number.isSafeInteger(claimedTotal) || claimedTotal > limits.maxTotalArtifactBytes) {
		return rejection(inputError("input_oversize"));
	}

	let inspectedTotal = 0;
	for (const artifact of input.artifacts) {
		let inspection: ExternalAgentArtifactInspection;
		try {
			inspection = cloneInspection(await options.inspectArtifact(artifact));
		} catch (error) {
			return rejection(error);
		}
		if (!inspection.trusted) return rejection(inputError("untrusted_artifact"));
		if (artifact.readHandle.kind === "workspace_relative" && !inspection.workspaceContained) {
			return rejection(inputError("input_workspace_escape"));
		}
		if (inspection.digest !== artifact.digest || inspection.digest !== artifactDigestFromId(inspection.artifactId)) {
			return rejection(inputError("digest_mismatch"));
		}
		if (inspection.sizeBytes > limits.maxArtifactBytes) {
			return rejection(inputError("input_oversize"));
		}
		if (
			inspection.artifactId !== artifact.artifactId ||
			inspection.ref !== artifact.readHandle.ref ||
			inspection.mediaType !== artifact.mediaType ||
			inspection.sizeBytes !== artifact.sizeBytes
		) {
			return rejection(inputError("reference_mismatch"));
		}
		inspectedTotal += inspection.sizeBytes;
		if (!Number.isSafeInteger(inspectedTotal) || inspectedTotal > limits.maxTotalArtifactBytes) {
			return rejection(inputError("input_oversize"));
		}
	}
	return {
		ok: true,
		input,
		requestFingerprint: fingerprintCanonicalExternalAgentInput(input),
	};
}
