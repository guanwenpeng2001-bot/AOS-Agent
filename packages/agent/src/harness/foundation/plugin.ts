import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import type { FingerprintV1 } from "./identity.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface PluginHookV1 { hookId: string; phase: "before" | "after" | "observe"; priority: number; before: readonly string[]; after: readonly string[]; conflict: "error" | "first" | "last"; capabilities: readonly string[]; }
export interface PluginManifestV1 { name: string; version: string; entrypoint: string; declaredCapabilities: readonly string[]; }
export interface PluginContractV1 { schemaVersion: 1; namespace: string; pluginId: string; version: string; manifest: PluginManifestV1; digest: FingerprintV1; signature: string; hooks: readonly PluginHookV1[]; features: readonly string[]; serviceIds?: readonly string[]; profileIds?: readonly string[]; rollbackSupported?: boolean; }
const pluginManifestSchema = Type.Object({ name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), entrypoint: Type.String({ minLength: 1 }), declaredCapabilities: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const pluginHookSchema = Type.Object({ hookId: Type.String({ minLength: 1 }), phase: Type.Union([Type.Literal("before"), Type.Literal("after"), Type.Literal("observe")]), priority: Type.Integer(), before: Type.Array(Type.String({ minLength: 1 })), after: Type.Array(Type.String({ minLength: 1 })), conflict: Type.Union([Type.Literal("error"), Type.Literal("first"), Type.Literal("last")]), capabilities: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const PluginContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), namespace: Type.String({ minLength: 1 }), pluginId: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), manifest: pluginManifestSchema, digest: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), signature: Type.String({ minLength: 1 }), hooks: Type.Array(pluginHookSchema), features: Type.Array(Type.String({ minLength: 1 })), serviceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), profileIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), rollbackSupported: Type.Optional(Type.Boolean()) }, { additionalProperties: false });

export type PluginLifecycleOperationV1 = "install" | "update" | "uninstall" | "rollback";
export interface PluginLifecycleRequestV1 { schemaVersion: 1; operation: PluginLifecycleOperationV1; plugin: PluginContractV1; targetRevision?: number; }
export interface PluginLifecycleResultV1 { schemaVersion: 1; operation: PluginLifecycleOperationV1; pluginId: string; revision: number; applied: boolean; }
export const PluginLifecycleRequestV1Schema = Type.Object({ schemaVersion: Type.Literal(1), operation: Type.Union([Type.Literal("install"), Type.Literal("update"), Type.Literal("uninstall"), Type.Literal("rollback")]), plugin: PluginContractV1Schema, targetRevision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const PluginLifecycleResultV1Schema = Type.Object({ schemaVersion: Type.Literal(1), operation: Type.Union([Type.Literal("install"), Type.Literal("update"), Type.Literal("uninstall"), Type.Literal("rollback")]), pluginId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), applied: Type.Boolean() }, { additionalProperties: false });
export function validatePluginContractV1(value: unknown): ResultValue<PluginContractV1, FoundationError> { return validateExactShape<PluginContractV1>(PluginContractV1Schema, value, "plugin_contract"); }
export function serializePluginContractV1(value: PluginContractV1): string { return serializeExactShape(PluginContractV1Schema, value, "plugin_contract"); }
export function parsePluginContractV1(text: string): ResultValue<PluginContractV1, FoundationError> { return parseExactShape(PluginContractV1Schema, text, "plugin_contract"); }
export function validatePluginLifecycleRequestV1(value: unknown): ResultValue<PluginLifecycleRequestV1, FoundationError> { return validateExactShape<PluginLifecycleRequestV1>(PluginLifecycleRequestV1Schema, value, "plugin_lifecycle_request"); }
export function serializePluginLifecycleRequestV1(value: PluginLifecycleRequestV1): string { return serializeExactShape(PluginLifecycleRequestV1Schema, value, "plugin_lifecycle_request"); }
export function parsePluginLifecycleRequestV1(text: string): ResultValue<PluginLifecycleRequestV1, FoundationError> { return parseExactShape(PluginLifecycleRequestV1Schema, text, "plugin_lifecycle_request"); }
export function validatePluginLifecycleResultV1(value: unknown): ResultValue<PluginLifecycleResultV1, FoundationError> { return validateExactShape<PluginLifecycleResultV1>(PluginLifecycleResultV1Schema, value, "plugin_lifecycle_result"); }
export function serializePluginLifecycleResultV1(value: PluginLifecycleResultV1): string { return serializeExactShape(PluginLifecycleResultV1Schema, value, "plugin_lifecycle_result"); }
export function parsePluginLifecycleResultV1(text: string): ResultValue<PluginLifecycleResultV1, FoundationError> { return parseExactShape(PluginLifecycleResultV1Schema, text, "plugin_lifecycle_result"); }
export function validatePluginHooksV1(hooks: readonly PluginHookV1[]): ResultValue<readonly PluginHookV1[], FoundationError> {
	const byId = new Map<string, PluginHookV1>();
	for (const hook of hooks) {
		if (byId.has(hook.hookId) || !Number.isInteger(hook.priority) || hook.before.includes(hook.hookId) || hook.after.includes(hook.hookId) || hook.before.some((id) => hook.after.includes(id))) return Result.err(new FoundationError("profile_conflict", "plugin hook ordering is not deterministic", { details: { hookId: hook.hookId } }));
		byId.set(hook.hookId, hook);
	}
	const edges = new Map<string, readonly string[]>(hooks.map((hook) => [hook.hookId, [...hook.before, ...hook.after]]));
	const visiting = new Set<string>(); const visited = new Set<string>();
	const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; const hook = byId.get(id); if (!hook) return false; visiting.add(id); for (const related of edges.get(id) ?? []) if (!visit(related)) return false; visiting.delete(id); visited.add(id); return true; };
	for (const hook of hooks) if (!visit(hook.hookId)) return Result.err(new FoundationError("profile_conflict", "plugin hook ordering contains an unknown dependency or cycle", { details: { hookId: hook.hookId } }));
	return Result.ok([...hooks].sort((left, right) => left.priority - right.priority || left.hookId.localeCompare(right.hookId)));
}
export function validatePluginDependenciesV1(plugin: PluginContractV1, availableFeatures: ReadonlySet<string>): ResultValue<PluginContractV1, FoundationError> { const missing = plugin.features.filter((feature) => !availableFeatures.has(feature)); return missing.length === 0 ? Result.ok(plugin) : Result.err(new FoundationError("profile_conflict", "plugin requires unavailable features", { details: { pluginId: plugin.pluginId, missing: [...missing] } })); }
