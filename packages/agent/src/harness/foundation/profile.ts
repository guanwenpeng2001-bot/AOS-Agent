import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ProfileKindV1 = "execution" | "capability" | "policy" | "model";
export interface ProfileContractV1 { schemaVersion: 1; profileId: string; revision: number; kind: ProfileKindV1; providerId?: string; values: Readonly<Record<string, string | number | boolean>>; capabilities?: readonly string[]; /** Immutable lock names supplied by the trusted profile authority. */ managedKeys: readonly string[]; createdAt: string; }
export const ProfileContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), profileId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), kind: Type.Union([Type.Literal("execution"), Type.Literal("capability"), Type.Literal("policy"), Type.Literal("model")]), providerId: Type.Optional(Type.String({ minLength: 1 })), values: Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Number(), Type.Boolean()])), capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), managedKeys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateProfileContractV1(value: unknown): ResultValue<ProfileContractV1, FoundationError> { return validateExactShape<ProfileContractV1>(ProfileContractV1Schema, value, "profile_contract"); }
export function serializeProfileContractV1(value: ProfileContractV1): string { return serializeExactShape(ProfileContractV1Schema, value, "profile_contract"); }
export function parseProfileContractV1(text: string): ResultValue<ProfileContractV1, FoundationError> { return parseExactShape(ProfileContractV1Schema, text, "profile_contract"); }

export interface ProfileRegistryV1 { schemaVersion: 1; profiles: readonly ProfileContractV1[]; activeProfileId?: string; }
export const ProfileRegistryV1Schema = Type.Object({ schemaVersion: Type.Literal(1), profiles: Type.Array(ProfileContractV1Schema), activeProfileId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export function resolveProfileV1(registry: ProfileRegistryV1, profileId: string): ResultValue<ProfileContractV1, FoundationError> { const profile = registry.profiles.find((candidate) => candidate.profileId === profileId); return profile ? Result.ok(profile) : Result.err(new FoundationError("model_profile_not_found", "profile is not registered", { details: { profileId } })); }

export type ExtensionKindV1 = "skill" | "lsp" | "monitor";
export interface SkillExtensionContractV1 { schemaVersion: 1; extensionId: string; kind: "skill"; version: string; capabilityRefs: readonly string[]; entrypoint: string; }
export interface LspExtensionContractV1 { schemaVersion: 1; extensionId: string; kind: "lsp"; version: string; languageIds: readonly string[]; serverCommand: string; initializationOptionsRef?: string; }
export interface MonitorExtensionContractV1 { schemaVersion: 1; extensionId: string; kind: "monitor"; version: string; eventKinds: readonly string[]; intervalMs: number; healthCheck: string; }
export type ExtensionContractV1 = SkillExtensionContractV1 | LspExtensionContractV1 | MonitorExtensionContractV1;
export type SkillExtensionV1 = SkillExtensionContractV1;
export type LspExtensionV1 = LspExtensionContractV1;
export type MonitorExtensionV1 = MonitorExtensionContractV1;
const extensionCommon = { schemaVersion: Type.Literal(1), extensionId: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) } as const;
export const ExtensionContractV1Schema = Type.Union([
	Type.Object({ ...extensionCommon, kind: Type.Literal("skill"), capabilityRefs: Type.Array(Type.String({ minLength: 1 })), entrypoint: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...extensionCommon, kind: Type.Literal("lsp"), languageIds: Type.Array(Type.String({ minLength: 1 })), serverCommand: Type.String({ minLength: 1 }), initializationOptionsRef: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ ...extensionCommon, kind: Type.Literal("monitor"), eventKinds: Type.Array(Type.String({ minLength: 1 })), intervalMs: Type.Integer({ minimum: 1 }), healthCheck: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export function validateExtensionContractV1(value: unknown): ResultValue<ExtensionContractV1, FoundationError> { return validateExactShape<ExtensionContractV1>(ExtensionContractV1Schema, value, "extension_contract"); }
export function serializeExtensionContractV1(value: ExtensionContractV1): string { return serializeExactShape(ExtensionContractV1Schema, value, "extension_contract"); }
export function parseExtensionContractV1(text: string): ResultValue<ExtensionContractV1, FoundationError> { return parseExactShape(ExtensionContractV1Schema, text, "extension_contract"); }
