import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import type { Fingerprint } from "./identity.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface PluginHook { hookId: string; phase: "before" | "after" | "observe"; priority: number; before: readonly string[]; after: readonly string[]; conflict: "error" | "first" | "last"; capabilities: readonly string[]; }
export interface PluginManifest { name: string; version: string; entrypoint: string; declaredCapabilities: readonly string[]; }
export interface PluginContract { schemaVersion: 1; namespace: string; pluginId: string; version: string; manifest: PluginManifest; digest: Fingerprint; signature: string; hooks: readonly PluginHook[]; features: readonly string[]; serviceIds?: readonly string[]; profileIds?: readonly string[]; rollbackSupported?: boolean; }
const pluginManifestSchema = Type.Object({ name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), entrypoint: Type.String({ minLength: 1 }), declaredCapabilities: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const pluginHookSchema = Type.Object({ hookId: Type.String({ minLength: 1 }), phase: Type.Union([Type.Literal("before"), Type.Literal("after"), Type.Literal("observe")]), priority: Type.Integer(), before: Type.Array(Type.String({ minLength: 1 })), after: Type.Array(Type.String({ minLength: 1 })), conflict: Type.Union([Type.Literal("error"), Type.Literal("first"), Type.Literal("last")]), capabilities: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const PluginContractSchema = Type.Object({ schemaVersion: Type.Literal(1), namespace: Type.String({ minLength: 1 }), pluginId: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), manifest: pluginManifestSchema, digest: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), signature: Type.String({ minLength: 1 }), hooks: Type.Array(pluginHookSchema), features: Type.Array(Type.String({ minLength: 1 })), serviceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), profileIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), rollbackSupported: Type.Optional(Type.Boolean()) }, { additionalProperties: false });

export type PluginLifecycleOperation = "install" | "update" | "uninstall" | "rollback";
export interface PluginLifecycleRequest { schemaVersion: 1; operation: PluginLifecycleOperation; plugin: PluginContract; targetRevision?: number; }
export interface PluginLifecycleResult { schemaVersion: 1; operation: PluginLifecycleOperation; pluginId: string; revision: number; applied: boolean; }
export const PluginLifecycleRequestSchema = Type.Object({ schemaVersion: Type.Literal(1), operation: Type.Union([Type.Literal("install"), Type.Literal("update"), Type.Literal("uninstall"), Type.Literal("rollback")]), plugin: PluginContractSchema, targetRevision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const PluginLifecycleResultSchema = Type.Object({ schemaVersion: Type.Literal(1), operation: Type.Union([Type.Literal("install"), Type.Literal("update"), Type.Literal("uninstall"), Type.Literal("rollback")]), pluginId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), applied: Type.Boolean() }, { additionalProperties: false });
export function validatePluginContract(value: unknown): ResultValue<PluginContract, FoundationError> { return validateExactShape<PluginContract>(PluginContractSchema, value, "plugin_contract"); }
export function serializePluginContract(value: PluginContract): string { return serializeExactShape(PluginContractSchema, value, "plugin_contract"); }
export function parsePluginContract(text: string): ResultValue<PluginContract, FoundationError> { return parseExactShape(PluginContractSchema, text, "plugin_contract"); }
export function validatePluginLifecycleRequest(value: unknown): ResultValue<PluginLifecycleRequest, FoundationError> { return validateExactShape<PluginLifecycleRequest>(PluginLifecycleRequestSchema, value, "plugin_lifecycle_request"); }
export function serializePluginLifecycleRequest(value: PluginLifecycleRequest): string { return serializeExactShape(PluginLifecycleRequestSchema, value, "plugin_lifecycle_request"); }
export function parsePluginLifecycleRequest(text: string): ResultValue<PluginLifecycleRequest, FoundationError> { return parseExactShape(PluginLifecycleRequestSchema, text, "plugin_lifecycle_request"); }
export function validatePluginLifecycleResult(value: unknown): ResultValue<PluginLifecycleResult, FoundationError> { return validateExactShape<PluginLifecycleResult>(PluginLifecycleResultSchema, value, "plugin_lifecycle_result"); }
export function serializePluginLifecycleResult(value: PluginLifecycleResult): string { return serializeExactShape(PluginLifecycleResultSchema, value, "plugin_lifecycle_result"); }
export function parsePluginLifecycleResult(text: string): ResultValue<PluginLifecycleResult, FoundationError> { return parseExactShape(PluginLifecycleResultSchema, text, "plugin_lifecycle_result"); }
export function validatePluginHooks(hooks: readonly PluginHook[]): ResultValue<readonly PluginHook[], FoundationError> {
	const byId = new Map<string, PluginHook>();
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
export function validatePluginDependencies(plugin: PluginContract, availableFeatures: ReadonlySet<string>): ResultValue<PluginContract, FoundationError> { const missing = plugin.features.filter((feature) => !availableFeatures.has(feature)); return missing.length === 0 ? Result.ok(plugin) : Result.err(new FoundationError("profile_conflict", "plugin requires unavailable features", { details: { pluginId: plugin.pluginId, missing: [...missing] } })); }
