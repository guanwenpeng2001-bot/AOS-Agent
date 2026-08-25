import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ProfileKind = "execution" | "capability" | "policy" | "model";
export interface ProfileContract { schemaVersion: 1; profileId: string; revision: number; kind: ProfileKind; providerId?: string; values: Readonly<Record<string, string | number | boolean>>; capabilities?: readonly string[]; /** Immutable lock names supplied by the trusted profile authority. */ managedKeys: readonly string[]; createdAt: string; }
export const ProfileContractSchema = Type.Object({ schemaVersion: Type.Literal(1), profileId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), kind: Type.Union([Type.Literal("execution"), Type.Literal("capability"), Type.Literal("policy"), Type.Literal("model")]), providerId: Type.Optional(Type.String({ minLength: 1 })), values: Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Number(), Type.Boolean()])), capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), managedKeys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateProfileContract(value: unknown): ResultValue<ProfileContract, FoundationError> { return validateExactShape<ProfileContract>(ProfileContractSchema, value, "profile_contract"); }
export function serializeProfileContract(value: ProfileContract): string { return serializeExactShape(ProfileContractSchema, value, "profile_contract"); }
export function parseProfileContract(text: string): ResultValue<ProfileContract, FoundationError> { return parseExactShape(ProfileContractSchema, text, "profile_contract"); }

export interface ProfileRegistry { schemaVersion: 1; profiles: readonly ProfileContract[]; activeProfileId?: string; }
export const ProfileRegistrySchema = Type.Object({ schemaVersion: Type.Literal(1), profiles: Type.Array(ProfileContractSchema), activeProfileId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export function resolveProfile(registry: ProfileRegistry, profileId: string): ResultValue<ProfileContract, FoundationError> { const profile = registry.profiles.find((candidate) => candidate.profileId === profileId); return profile ? Result.ok(profile) : Result.err(new FoundationError("model_profile_not_found", "profile is not registered", { details: { profileId } })); }

export type ExtensionKind = "skill" | "lsp" | "monitor";
export interface SkillExtensionContract { schemaVersion: 1; extensionId: string; kind: "skill"; version: string; capabilityRefs: readonly string[]; entrypoint: string; }
export interface LspExtensionContract { schemaVersion: 1; extensionId: string; kind: "lsp"; version: string; languageIds: readonly string[]; serverCommand: string; initializationOptionsRef?: string; }
export interface MonitorExtensionContract { schemaVersion: 1; extensionId: string; kind: "monitor"; version: string; eventKinds: readonly string[]; intervalMs: number; healthCheck: string; }
export type ExtensionContract = SkillExtensionContract | LspExtensionContract | MonitorExtensionContract;
const extensionCommon = { schemaVersion: Type.Literal(1), extensionId: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) } as const;
export const ExtensionContractSchema = Type.Union([
	Type.Object({ ...extensionCommon, kind: Type.Literal("skill"), capabilityRefs: Type.Array(Type.String({ minLength: 1 })), entrypoint: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...extensionCommon, kind: Type.Literal("lsp"), languageIds: Type.Array(Type.String({ minLength: 1 })), serverCommand: Type.String({ minLength: 1 }), initializationOptionsRef: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ ...extensionCommon, kind: Type.Literal("monitor"), eventKinds: Type.Array(Type.String({ minLength: 1 })), intervalMs: Type.Integer({ minimum: 1 }), healthCheck: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export function validateExtensionContract(value: unknown): ResultValue<ExtensionContract, FoundationError> { return validateExactShape<ExtensionContract>(ExtensionContractSchema, value, "extension_contract"); }
export function serializeExtensionContract(value: ExtensionContract): string { return serializeExactShape(ExtensionContractSchema, value, "extension_contract"); }
export function parseExtensionContract(text: string): ResultValue<ExtensionContract, FoundationError> { return parseExactShape(ExtensionContractSchema, text, "extension_contract"); }
