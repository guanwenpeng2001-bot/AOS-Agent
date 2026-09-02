import type {
	ModelProfile,
	ResourceSelector,
	RoleDefinition,
	RoleDefinitionPatch,
	RoleRegistryRecord,
	RoleTombstone,
} from "@aos-agent/agent-core";
import type {
	GetExecutionPolicyData,
	RoleStudioModelProfileDraft,
	RoleStudioModelProfileListData,
	RoleStudioPreviewData,
	RoleStudioRoleListData,
} from "../rpc/rpc-types.ts";
import { WebRpcRequestError } from "./read-only-rpc.ts";

export const ROLE_STUDIO_READ_METHODS = [
	"role.list",
	"role.get",
	"role.preview",
	"model_profile.list",
	"model_profile.get",
	"policy.get",
] as const;

export const ROLE_STUDIO_WRITE_METHODS = [
	"role.create",
	"role.edit",
	"role.copy",
	"role.delete",
	"model_profile.put",
] as const;

export interface RoleStudioRpcClient {
	listRoles(options?: { scope?: "global" | "project"; includeTombstones?: boolean }): Promise<RoleStudioRoleListData>;
	getRole(
		roleId: string,
		options?: { scope?: "global" | "project"; includeTombstone?: boolean },
	): Promise<RoleRegistryRecord>;
	createRole(definition: RoleDefinition): Promise<RoleRegistryRecord>;
	editRole(
		roleId: string,
		scope: "global" | "project",
		expectedRevision: number,
		patch: RoleDefinitionPatch,
	): Promise<RoleRegistryRecord>;
	copyRole(
		sourceRoleId: string,
		sourceScope: "global" | "project",
		targetRoleId: string,
		targetScope: "global" | "project",
		expectedRevision: number,
	): Promise<RoleRegistryRecord>;
	deleteRole(
		roleId: string,
		scope: "global" | "project",
		expectedRevision: number,
		reason?: string,
	): Promise<RoleTombstone>;
	previewRoleBinding(
		definition: RoleDefinition,
		modelProfile: ModelProfile,
		parentCapabilitySelector?: ResourceSelector,
	): Promise<RoleStudioPreviewData>;
	listModelProfiles(): Promise<RoleStudioModelProfileListData>;
	getModelProfile(modelProfileId: string, revision?: number): Promise<ModelProfile>;
	putModelProfile(profile: RoleStudioModelProfileDraft, expectedRevision?: number): Promise<ModelProfile>;
	getExecutionPolicy(): Promise<GetExecutionPolicyData>;
}

export async function invokeRoleStudioReadRpc(
	client: RoleStudioRpcClient,
	method: string,
	params: unknown,
): Promise<unknown> {
	const record = params === undefined ? {} : requireRecord(params);
	switch (method) {
		case "role.list":
			return client.listRoles({
				...(record.scope === undefined ? {} : { scope: requireScope(record, "scope") }),
				...(record.includeTombstones === undefined
					? {}
					: { includeTombstones: requireBoolean(record, "includeTombstones") }),
			});
		case "role.get":
			return client.getRole(requireString(record, "roleId"), {
				...(record.scope === undefined ? {} : { scope: requireScope(record, "scope") }),
				...(record.includeTombstone === undefined
					? {}
					: { includeTombstone: requireBoolean(record, "includeTombstone") }),
			});
		case "role.preview":
			return client.previewRoleBinding(
				requireObject<RoleDefinition>(record, "definition"),
				requireObject<ModelProfile>(record, "modelProfile"),
				record.parentCapabilitySelector === undefined
					? undefined
					: requireObject<ResourceSelector>(record, "parentCapabilitySelector"),
			);
		case "model_profile.list":
			return client.listModelProfiles();
		case "model_profile.get":
			return client.getModelProfile(
				requireString(record, "modelProfileId"),
				record.revision === undefined ? undefined : requireNonNegativeInteger(record, "revision"),
			);
		case "policy.get":
			return client.getExecutionPolicy();
		default:
			throw new WebRpcRequestError(
				403,
				"method_not_allowed",
				"RPC method is not available on the Role Studio read surface.",
			);
	}
}

export async function invokeRoleStudioWriteRpc(
	client: RoleStudioRpcClient,
	method: string,
	params: unknown,
): Promise<unknown> {
	const record = requireRecord(params);
	if (record.confirmed !== true) throw invalidRequest("confirmed must be true");
	switch (method) {
		case "role.create":
			requireExactKeys(record, ["definition", "confirmed"]);
			return client.createRole(requireObject<RoleDefinition>(record, "definition"));
		case "role.edit":
			requireExactKeys(record, ["roleId", "scope", "expectedRevision", "patch", "confirmed"]);
			return client.editRole(
				requireString(record, "roleId"),
				requireScope(record, "scope"),
				requireNonNegativeInteger(record, "expectedRevision"),
				requireObject<RoleDefinitionPatch>(record, "patch"),
			);
		case "role.copy":
			requireExactKeys(record, [
				"sourceRoleId",
				"sourceScope",
				"targetRoleId",
				"targetScope",
				"expectedRevision",
				"confirmed",
			]);
			return client.copyRole(
				requireString(record, "sourceRoleId"),
				requireScope(record, "sourceScope"),
				requireString(record, "targetRoleId"),
				requireScope(record, "targetScope"),
				requireNonNegativeInteger(record, "expectedRevision"),
			);
		case "role.delete":
			requireAllowedKeys(record, ["roleId", "scope", "expectedRevision", "reason", "confirmed"]);
			return client.deleteRole(
				requireString(record, "roleId"),
				requireScope(record, "scope"),
				requireNonNegativeInteger(record, "expectedRevision"),
				record.reason === undefined ? undefined : requireString(record, "reason"),
			);
		case "model_profile.put":
			requireAllowedKeys(record, ["profile", "expectedRevision", "confirmed"]);
			return client.putModelProfile(
				requireObject<RoleStudioModelProfileDraft>(record, "profile"),
				record.expectedRevision === undefined ? undefined : requireNonNegativeInteger(record, "expectedRevision"),
			);
		default:
			throw new WebRpcRequestError(
				403,
				"method_not_allowed",
				"RPC method is not available on the Role Studio write surface.",
			);
	}
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw invalidRequest("params must be a JSON object");
	return value as Record<string, unknown>;
}

function requireObject<T>(record: Record<string, unknown>, key: string): T {
	const value = record[key];
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw invalidRequest(`${key} must be a JSON object`);
	return value as T;
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0)
		throw invalidRequest(`${key} must be a non-empty string`);
	return value;
}

function requireScope(record: Record<string, unknown>, key: string): "global" | "project" {
	const value = record[key];
	if (value !== "global" && value !== "project") throw invalidRequest(`${key} must be global or project`);
	return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw invalidRequest(`${key} must be a boolean`);
	return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw invalidRequest(`${key} must be a non-negative integer`);
	return value;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(record).length !== keys.length || !keys.every((key) => key in record))
		throw invalidRequest("params must contain exactly the supported fields");
}

function requireAllowedKeys(record: Record<string, unknown>, keys: readonly string[]): void {
	if (!Object.keys(record).every((key) => keys.includes(key)))
		throw invalidRequest("params contain unsupported fields");
}

function invalidRequest(message: string): WebRpcRequestError {
	return new WebRpcRequestError(400, "invalid_request", message);
}
