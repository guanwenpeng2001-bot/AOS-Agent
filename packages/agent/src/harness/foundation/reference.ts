import { Type } from "typebox";
import type { Fingerprint } from "./identity.ts";
import { FingerprintSchema } from "./schema.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import type { FoundationError } from "./errors.ts";
import type { Result as ResultValue } from "../result.ts";

export interface VersionedReference { schemaVersion: 1; type: string; id: string; revision?: number; fingerprint?: Fingerprint; providerId?: string; }
export const VersionedReferenceSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintSchema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
/** A reference used by an immutable binding; the revision is never implicit. */
export interface RevisionReference extends Omit<VersionedReference, "revision"> { revision: number; }
export const RevisionReferenceSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintSchema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface ArtifactRef { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; producer?: string; sizeBytes?: number; }
export const FOUNDATION_SHA256_DIGEST_PATTERN = "^sha256:[A-Fa-f0-9]{64}$" as const;
const artifactDigestSchema = Type.String({ pattern: FOUNDATION_SHA256_DIGEST_PATTERN });
export const ArtifactRefSchema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: artifactDigestSchema, producer: Type.Optional(Type.String({ minLength: 1 })), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export interface ArtifactRefPublicProjection { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; }
export const ArtifactRefPublicProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ pattern: FOUNDATION_SHA256_DIGEST_PATTERN }) }, { additionalProperties: false });
export function projectArtifactRef(value: ArtifactRef): ArtifactRefPublicProjection { return { schemaVersion: 1, artifactId: value.artifactId, mediaType: value.mediaType, digest: value.digest }; }

/** AttemptReceipt may reference only a bounded WorkerReceipt, never another result layer. */
export interface WorkerReceiptRef extends RevisionReference { type: "worker_receipt"; }
export const WorkerReceiptRefSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("worker_receipt"), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintSchema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export type ArtifactReferenceValidationState = "verified" | "pending" | "corrupt" | "unknown";
export interface ArtifactDescriptor { schemaVersion: 1; artifactId: string; name: string; mediaType: string; digest: string; producer?: string; permissions: readonly string[]; retention: { policy: "session" | "goal" | "project" | "indefinite"; expiresAt?: string }; validationState: ArtifactReferenceValidationState; sizeBytes?: number; }
const artifactRetentionSchema = Type.Union([
	Type.Object({ policy: Type.Literal("session"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("goal"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("project"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("indefinite"), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
export const ArtifactDescriptorSchema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: artifactDigestSchema, producer: Type.Optional(Type.String({ minLength: 1 })), permissions: Type.Array(Type.String({ minLength: 1 })), retention: artifactRetentionSchema, validationState: Type.Union([Type.Literal("verified"), Type.Literal("pending"), Type.Literal("corrupt"), Type.Literal("unknown")]), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export type ResourceSelectorPolicy = "all" | "none" | "named" | "except";
export interface ResourceSelector { policy: ResourceSelectorPolicy; named?: readonly string[]; }
export const ResourceSelectorSchema = Type.Union([
	Type.Object({ policy: Type.Literal("all") }, { additionalProperties: false }), Type.Object({ policy: Type.Literal("none") }, { additionalProperties: false }),
	Type.Object({ policy: Type.Literal("named"), named: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }), Type.Object({ policy: Type.Literal("except"), named: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
export function selectorsNarrow(parent: ResourceSelector, child: ResourceSelector): boolean {
	if (parent.policy === "none") return child.policy === "none";
	if (parent.policy === "all") return true;
	if (child.policy === "all") return false;
	if (child.policy === "none") return true;
	const parentNames = new Set(parent.named ?? []); const childNames = new Set(child.named ?? []);
	if (parent.policy === "named") return child.policy === "named" && [...childNames].every((name) => parentNames.has(name));
	if (child.policy === "named") return [...childNames].every((name) => !parentNames.has(name));
	return [...parentNames].every((name) => childNames.has(name));
}

export function validateVersionedReference(value: unknown): ResultValue<VersionedReference, FoundationError> { return validateExactShape<VersionedReference>(VersionedReferenceSchema, value, "versioned_reference"); }
export function serializeVersionedReference(value: VersionedReference): string { return serializeExactShape(VersionedReferenceSchema, value, "versioned_reference"); }
export function parseVersionedReference(text: string): ResultValue<VersionedReference, FoundationError> { return parseExactShape(VersionedReferenceSchema, text, "versioned_reference"); }
export function validateWorkerReceiptRef(value: unknown): ResultValue<WorkerReceiptRef, FoundationError> { return validateExactShape<WorkerReceiptRef>(WorkerReceiptRefSchema, value, "worker_receipt_ref"); }
export function serializeWorkerReceiptRef(value: WorkerReceiptRef): string { return serializeExactShape(WorkerReceiptRefSchema, value, "worker_receipt_ref"); }
export function parseWorkerReceiptRef(text: string): ResultValue<WorkerReceiptRef, FoundationError> { return parseExactShape<WorkerReceiptRef>(WorkerReceiptRefSchema, text, "worker_receipt_ref"); }
export function validateArtifactRef(value: unknown): ResultValue<ArtifactRef, FoundationError> { return validateExactShape<ArtifactRef>(ArtifactRefSchema, value, "artifact_ref"); }
export function serializeArtifactRef(value: ArtifactRef): string { return serializeExactShape(ArtifactRefSchema, value, "artifact_ref"); }
export function parseArtifactRef(text: string): ResultValue<ArtifactRef, FoundationError> { return parseExactShape(ArtifactRefSchema, text, "artifact_ref"); }
export function validateArtifactDescriptor(value: unknown): ResultValue<ArtifactDescriptor, FoundationError> { return validateExactShape<ArtifactDescriptor>(ArtifactDescriptorSchema, value, "artifact_descriptor"); }
export function serializeArtifactDescriptor(value: ArtifactDescriptor): string { return serializeExactShape(ArtifactDescriptorSchema, value, "artifact_descriptor"); }
export function parseArtifactDescriptor(text: string): ResultValue<ArtifactDescriptor, FoundationError> { return parseExactShape(ArtifactDescriptorSchema, text, "artifact_descriptor"); }
export function validateArtifactRefPublicProjection(value: unknown): ResultValue<ArtifactRefPublicProjection, FoundationError> { return validateExactShape<ArtifactRefPublicProjection>(ArtifactRefPublicProjectionSchema, value, "artifact_ref_public_projection"); }
export function serializeArtifactRefPublicProjection(value: ArtifactRefPublicProjection): string { return serializeExactShape(ArtifactRefPublicProjectionSchema, value, "artifact_ref_public_projection"); }
export function parseArtifactRefPublicProjection(text: string): ResultValue<ArtifactRefPublicProjection, FoundationError> { return parseExactShape(ArtifactRefPublicProjectionSchema, text, "artifact_ref_public_projection"); }
