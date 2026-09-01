import {
	createRoleRevision,
	fingerprintFoundationValue,
	type McpSelection,
	type ModelProfile,
	type ResourceSelector,
	type RevisionReference,
	ROLE_RESOLUTION_ORDER,
	type RoleDefinition,
	type RoleResolutionLayer,
	type RoleResolutionPreview,
	type RoleResolveInput,
	resolveRoleResolution,
	validateRoleSelectorTightening,
} from "@aos-agent/agent-core";

export interface RoleStudioPreviewInput {
	readonly definition: RoleDefinition;
	readonly modelProfile: ModelProfile;
	readonly parentCapabilitySelector?: ResourceSelector;
}

export interface RoleStudioPermissionPreview {
	readonly parent: ResourceSelector;
	readonly requested: ResourceSelector;
	readonly tightens: boolean;
	readonly reason?: string;
}

export interface RoleStudioPreviewData {
	readonly permission: RoleStudioPermissionPreview;
	readonly resolution?: RoleResolutionPreview;
}

const PREVIEW_TIME = "1970-01-01T00:00:00.000Z";

function previewReference(type: string, id: string): RevisionReference {
	const payload = { type, id, revision: 1 };
	return { schemaVersion: 1, ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function previewMcpSelection(selector: ResourceSelector, capabilityBindingId: string): McpSelection {
	const normalized =
		selector.policy === "all" || selector.policy === "none"
			? { policy: selector.policy }
			: { policy: selector.policy, named: [...new Set(selector.named ?? [])].sort() };
	const servers =
		selector.policy === "named"
			? [...new Set(selector.named ?? [])].sort().map((serverId) => ({
					serverId,
					descriptorId: `role-studio:${serverId}`,
					descriptorRevision: "preview",
					tools: [],
				}))
			: [];
	const base = {
		schemaVersion: 1 as const,
		capabilityBindingId,
		selectorDigest: fingerprintFoundationValue(normalized),
		servers,
	};
	return { ...base, digest: fingerprintFoundationValue(base) };
}

export function buildRoleStudioResolutionInput(input: RoleStudioPreviewInput): RoleResolveInput & {
	readonly roleRevision: ReturnType<typeof createRoleRevision>;
} {
	const roleRevision = createRoleRevision({ definition: input.definition, now: () => PREVIEW_TIME });
	const parent = input.parentCapabilitySelector ?? { policy: "all" };
	const capabilityRevision = previewReference("capability_binding", "role-studio-capability");
	const orderedLayers: RoleResolutionLayer[] = ROLE_RESOLUTION_ORDER.map((layer, ordinal) => ({
		schemaVersion: 1,
		layer,
		ordinal,
		referenceId: `role-studio:${layer}`,
		revision: 1,
		overrideReason: "role_studio_preview",
	}));
	return {
		schemaVersion: 1,
		task: {
			schemaVersion: 1,
			taskId: "role-studio-preview-task",
			goalId: "role-studio-preview-goal",
			goal: "Preview the resolved Role binding",
			workspace: "role-studio-preview",
			capabilityRefs: [],
			inputs: [],
			expectedOutputs: [],
			budget: {},
			acceptanceCriteria: [],
			status: "draft",
			createdAt: PREVIEW_TIME,
			updatedAt: PREVIEW_TIME,
		},
		roleId: input.definition.roleId,
		scope: input.definition.scope,
		modelProfile: input.modelProfile,
		orderedLayers,
		contextRevision: previewReference("external_agent_binding", "role-studio-external-agent"),
		capabilityRevision,
		modelBrokerBindingRevision: previewReference("model_broker_binding", "role-studio-model-broker"),
		policyRevision: previewReference(
			"policy_binding",
			input.definition.executionPolicyRef?.id ?? "role-studio-policy",
		),
		mcpSelection: previewMcpSelection(input.definition.mcpSelector, capabilityRevision.id),
		overrides:
			parent.policy === "all"
				? []
				: [
						{
							schemaVersion: 1,
							layer: "managed_lock",
							referenceId: "role-studio-managed-lock",
							revision: 1,
							overrideReason: "permission_preview",
							capabilitySelector: parent,
						},
					],
		bindingId: "role-studio-preview-binding",
		now: () => PREVIEW_TIME,
		roleRevision,
	};
}

/** Pure preview. It shares the production Resolver and never appends Session facts. */
export function createRoleStudioPreview(input: RoleStudioPreviewInput): RoleStudioPreviewData {
	const parent = input.parentCapabilitySelector ?? { policy: "all" };
	const permission = validateRoleSelectorTightening(parent, input.definition.capabilitySelector);
	if (!permission.ok) {
		return {
			permission: {
				parent,
				requested: input.definition.capabilitySelector,
				tightens: false,
				reason: permission.error.message,
			},
		};
	}
	const resolutionInput = buildRoleStudioResolutionInput(input);
	const resolved = resolveRoleResolution(resolutionInput);
	if (!resolved.ok) throw resolved.error;
	return {
		permission: { parent, requested: input.definition.capabilitySelector, tightens: true },
		resolution: resolved.value,
	};
}
