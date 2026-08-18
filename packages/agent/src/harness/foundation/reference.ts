import { Type } from "typebox";
import type { FingerprintV1 } from "./identity.ts";
import { FingerprintV1Schema } from "./schema.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import type { FoundationError } from "./errors.ts";
import type { Result as ResultValue } from "../result.ts";

export interface VersionedReferenceV1 { schemaVersion: 1; type: string; id: string; revision?: number; fingerprint?: FingerprintV1; providerId?: string; }
export const VersionedReferenceV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintV1Schema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
/** A reference used by an immutable binding; the revision is never implicit. */
export interface RevisionReferenceV1 extends Omit<VersionedReferenceV1, "revision"> { revision: number; }
export const RevisionReferenceV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintV1Schema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface ArtifactRefV1 { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; producer?: string; sizeBytes?: number; }
export type ArtifactRef = ArtifactRefV1;
export const FOUNDATION_SHA256_DIGEST_PATTERN_V1 = "^sha256:[A-Fa-f0-9]{64}$" as const;
const artifactDigestSchema = Type.String({ pattern: FOUNDATION_SHA256_DIGEST_PATTERN_V1 });
export const ArtifactRefV1Schema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: artifactDigestSchema, producer: Type.Optional(Type.String({ minLength: 1 })), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const ArtifactRefSchema = ArtifactRefV1Schema;
export interface ArtifactRefPublicProjectionV1 { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; }
export const ArtifactRefPublicProjectionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ pattern: FOUNDATION_SHA256_DIGEST_PATTERN_V1 }) }, { additionalProperties: false });
export function projectArtifactRefV1(value: ArtifactRefV1): ArtifactRefPublicProjectionV1 { return { schemaVersion: 1, artifactId: value.artifactId, mediaType: value.mediaType, digest: value.digest }; }

/** AttemptReceipt may reference only a bounded WorkerReceipt, never another result layer. */
export interface WorkerReceiptRefV1 extends RevisionReferenceV1 { type: "worker_receipt"; }
export const WorkerReceiptRefV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("worker_receipt"), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintV1Schema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export type ArtifactValidationStateV1 = "verified" | "pending" | "corrupt" | "unknown";
export interface ArtifactDescriptorV1 { schemaVersion: 1; artifactId: string; name: string; mediaType: string; digest: string; producer?: string; permissions: readonly string[]; retention: { policy: "session" | "goal" | "project" | "indefinite"; expiresAt?: string }; validationState: ArtifactValidationStateV1; sizeBytes?: number; }
const artifactRetentionSchema = Type.Union([
	Type.Object({ policy: Type.Literal("session"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("goal"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("project"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("indefinite"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
export const ArtifactDescriptorV1Schema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: artifactDigestSchema, producer: Type.Optional(Type.String({ minLength: 1 })), permissions: Type.Array(Type.String({ minLength: 1 })), retention: artifactRetentionSchema, validationState: Type.Union([Type.Literal("verified"), Type.Literal("pending"), Type.Literal("corrupt"), Type.Literal("unknown")]), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export type ResourceSelectorPolicyV1 = "all" | "none" | "named" | "except";
export interface ResourceSelectorV1 { policy: ResourceSelectorPolicyV1; named?: readonly string[]; }
export const ResourceSelectorV1Schema = Type.Union([
	Type.Object({ policy: Type.Literal("all") }, { additionalProperties: false }), Type.Object({ policy: Type.Literal("none") }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("named"), named: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }), Type.Object({ policy: Type.Literal("except"), named: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
export type CapabilitySelectorV1 = ResourceSelectorV1;
export const CapabilitySelectorV1Schema = ResourceSelectorV1Schema;
export function selectorsNarrow(parent: ResourceSelectorV1, child: ResourceSelectorV1): boolean {
	if (parent.policy === "none") return child.policy === "none";
	if (parent.policy === "all") return true;
	if (child.policy === "all") return false;
	if (child.policy === "none") return true;
	const parentNames = new Set(parent.named ?? []); const childNames = new Set(child.named ?? []);
	if (parent.policy === "named") return child.policy === "named" && [...childNames].every((name) => parentNames.has(name));
	if (child.policy === "named") return [...childNames].every((name) => !parentNames.has(name));
	return [...parentNames].every((name) => childNames.has(name));
}

export function validateVersionedReferenceV1(value: unknown): ResultValue<VersionedReferenceV1, FoundationError> { return validateExactShape<VersionedReferenceV1>(VersionedReferenceV1Schema, value, "versioned_reference"); }
export function serializeVersionedReferenceV1(value: VersionedReferenceV1): string { return serializeExactShape(VersionedReferenceV1Schema, value, "versioned_reference"); }
export function parseVersionedReferenceV1(text: string): ResultValue<VersionedReferenceV1, FoundationError> { return parseExactShape(VersionedReferenceV1Schema, text, "versioned_reference"); }
export function validateWorkerReceiptRefV1(value: unknown): ResultValue<WorkerReceiptRefV1, FoundationError> { return validateExactShape<WorkerReceiptRefV1>(WorkerReceiptRefV1Schema, value, "worker_receipt_ref"); }
export function serializeWorkerReceiptRefV1(value: WorkerReceiptRefV1): string { return serializeExactShape(WorkerReceiptRefV1Schema, value, "worker_receipt_ref"); }
export function parseWorkerReceiptRefV1(text: string): ResultValue<WorkerReceiptRefV1, FoundationError> { return parseExactShape<WorkerReceiptRefV1>(WorkerReceiptRefV1Schema, text, "worker_receipt_ref"); }
export function validateArtifactRef(value: unknown): ResultValue<ArtifactRefV1, FoundationError> { return validateExactShape<ArtifactRefV1>(ArtifactRefV1Schema, value, "artifact_ref"); }
export function serializeArtifactRef(value: ArtifactRefV1): string { return serializeExactShape(ArtifactRefV1Schema, value, "artifact_ref"); }
export function parseArtifactRef(text: string): ResultValue<ArtifactRefV1, FoundationError> { return parseExactShape(ArtifactRefV1Schema, text, "artifact_ref"); }
export function validateArtifactDescriptorV1(value: unknown): ResultValue<ArtifactDescriptorV1, FoundationError> { return validateExactShape<ArtifactDescriptorV1>(ArtifactDescriptorV1Schema, value, "artifact_descriptor"); }
export function serializeArtifactDescriptorV1(value: ArtifactDescriptorV1): string { return serializeExactShape(ArtifactDescriptorV1Schema, value, "artifact_descriptor"); }
export function parseArtifactDescriptorV1(text: string): ResultValue<ArtifactDescriptorV1, FoundationError> { return parseExactShape(ArtifactDescriptorV1Schema, text, "artifact_descriptor"); }
export function validateArtifactRefPublicProjectionV1(value: unknown): ResultValue<ArtifactRefPublicProjectionV1, FoundationError> { return validateExactShape<ArtifactRefPublicProjectionV1>(ArtifactRefPublicProjectionV1Schema, value, "artifact_ref_public_projection"); }
export function serializeArtifactRefPublicProjectionV1(value: ArtifactRefPublicProjectionV1): string { return serializeExactShape(ArtifactRefPublicProjectionV1Schema, value, "artifact_ref_public_projection"); }
export function parseArtifactRefPublicProjectionV1(text: string): ResultValue<ArtifactRefPublicProjectionV1, FoundationError> { return parseExactShape(ArtifactRefPublicProjectionV1Schema, text, "artifact_ref_public_projection"); }
export const validateArtifactDescriptor = validateArtifactDescriptorV1;
export const serializeArtifactDescriptor = serializeArtifactDescriptorV1;
export const parseArtifactDescriptor = parseArtifactDescriptorV1;
