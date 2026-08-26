import {
	canonicalFoundationJson,
	fingerprintFoundationValue,
	FoundationError,
	sha256HexValue,
	validateRoleRevision,
	validateSecretFreeModelProfile,
	type FoundationJsonValue,
	type ModelProfile,
	type RoleRevision,
	type Session,
	type ThinkingLevel,
} from "@aos-agent/agent-core";
import type { Api, Model } from "@aos-agent/ai";
import {
	PROMPT_TASK_DEPENDENCY_NAMES,
	type PromptTaskCompositionDependencies,
	type PromptTaskDependencyName,
	type PromptTaskDependencyResolution,
} from "./prompt-task-adapter.ts";

const BUILTIN_REVISION_DECLARED_AT = "1970-01-01T00:00:00.000Z";

const DEPENDENCY_FACT_TYPES = {
	context: "context_snapshot",
	model: "model_broker_binding",
	capability: "capability_binding",
	mcp: "mcp_binding",
	policy: "policy_binding",
	sandbox: "sandbox_binding",
	audit: "audit_binding",
	run: "run_binding",
	gate: "task_gate_binding",
	graph: "task_graph_binding",
	credential: "credential_lease_binding",
	adapter: "external_agent_binding",
} as const satisfies Record<PromptTaskDependencyName, string>;

export interface ProductPromptDependencySnapshotContextV1 {
	readonly runId: string;
	readonly goalId: string;
	readonly taskId: string;
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
}

export interface ProductPromptBindingRevisionAuthorityOptionsV1 {
	readonly session: Session;
	readonly roleId: string;
	readonly providerId: string;
	readonly dependencySnapshot: (
		name: PromptTaskDependencyName,
		context: ProductPromptDependencySnapshotContextV1,
	) => FoundationJsonValue;
}

export interface ProductPromptBindingRevisionFactsV1 {
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
	readonly dependencies: PromptTaskCompositionDependencies;
}

function immutableJson<T extends FoundationJsonValue>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Array.isArray(value) ? value : Object.values(value)) immutableJson(child);
		Object.freeze(value);
	}
	return value;
}

function factToken(value: FoundationJsonValue): string {
	return sha256HexValue(canonicalFoundationJson(value)).slice(0, 32);
}

function modelRouteIdentity(model: Model<Api>, thinkingLevel: ThinkingLevel): FoundationJsonValue {
	return {
		provider: model.provider,
		model: model.id,
		...(thinkingLevel === "off" ? {} : { effort: thinkingLevel }),
	};
}

export function deriveProductPromptModelProfileIdV1(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
): string {
	return `model_profile_coding_agent_${factToken(modelRouteIdentity(model, thinkingLevel))}`;
}

/**
 * Composition-owned authority for immutable product binding revisions.
 *
 * Facts use content-derived identities and a fixed declaration timestamp, so
 * independent ingress instances resolve the same Role, ModelProfile,
 * Capability, and Policy revisions instead of minting per-Run wrappers.
 */
export class ProductPromptBindingRevisionAuthorityV1 {
	private readonly options: ProductPromptBindingRevisionAuthorityOptionsV1;

	constructor(options: ProductPromptBindingRevisionAuthorityOptionsV1) {
		this.options = options;
	}

	private async existingPayload(objectType: string, objectId: string): Promise<FoundationJsonValue | undefined> {
		const existing = await this.options.session.getFoundationObject(objectType, objectId);
		if (existing === undefined) return undefined;
		if (existing.kind !== "fact" || existing.objectType !== objectType || existing.objectId !== objectId) {
			throw new FoundationError("session_ledger_conflict", `${objectType} ${objectId} is not an immutable binding fact`);
		}
		return existing.payload;
	}

	private async resolveModelProfile(
		model: Model<Api>,
		thinkingLevel: ThinkingLevel,
	): Promise<ModelProfile> {
		const modelProfileId = deriveProductPromptModelProfileIdV1(model, thinkingLevel);
		const existing = await this.existingPayload("model_profile_revision", modelProfileId);
		if (existing !== undefined) {
			const checked = validateSecretFreeModelProfile(existing);
			if (
				!checked.ok || checked.value.modelProfileId !== modelProfileId ||
				checked.value.provider !== model.provider || checked.value.model !== model.id ||
				checked.value.effort !== (thinkingLevel === "off" ? undefined : thinkingLevel)
			) {
				throw new FoundationError("session_ledger_conflict", `ModelProfile revision ${modelProfileId} conflicts with its route`);
			}
			return checked.value;
		}
		const base = {
			schemaVersion: 1 as const,
			modelProfileId,
			name: "AOS Coding Agent prompt route",
			provider: model.provider,
			model: model.id,
			...(thinkingLevel === "off" ? {} : { effort: thinkingLevel }),
			budget: {},
			revision: 1,
			createdAt: BUILTIN_REVISION_DECLARED_AT,
		};
		const checked = validateSecretFreeModelProfile({ ...base, fingerprint: fingerprintFoundationValue(base) });
		if (!checked.ok) throw checked.error;
		return checked.value;
	}

	private async resolveRoleRevision(modelProfile: ModelProfile): Promise<RoleRevision> {
		const roleIdentity = {
			roleId: this.options.roleId,
			modelProfileId: modelProfile.modelProfileId,
			modelProfileRevision: modelProfile.revision,
			modelProfileFingerprint: modelProfile.fingerprint.value,
		};
		const roleRevisionId = `role_revision_coding_agent_${factToken(roleIdentity)}`;
		const existing = await this.existingPayload("role_revision", roleRevisionId);
		if (existing !== undefined) {
			const checked = validateRoleRevision(existing);
			if (
				!checked.ok || checked.value.roleRevisionId !== roleRevisionId ||
				checked.value.roleId !== this.options.roleId ||
				canonicalFoundationJson(checked.value.modelProfileRef) !== canonicalFoundationJson({
					schemaVersion: 1,
					type: "model_profile",
					id: modelProfile.modelProfileId,
					revision: modelProfile.revision,
					fingerprint: modelProfile.fingerprint,
				})
			) {
				throw new FoundationError("session_ledger_conflict", `Role revision ${roleRevisionId} conflicts with its ModelProfile`);
			}
			return checked.value;
		}
		const base = {
			schemaVersion: 1 as const,
			roleRevisionId,
			roleId: this.options.roleId,
			scope: "global" as const,
			revision: 1,
			slug: "coding-agent",
			name: "AOS Coding Agent",
			description: "Built-in coding-agent product role",
			persona: "Execute the bound coding task through the canonical AgentHarness",
			modelProfileRef: {
				schemaVersion: 1 as const,
				type: "model_profile" as const,
				id: modelProfile.modelProfileId,
				revision: modelProfile.revision,
				fingerprint: modelProfile.fingerprint,
			},
			capabilitySelector: { policy: "all" as const },
			skillSelector: { policy: "all" as const },
			mcpSelector: { policy: "all" as const },
			createdAt: BUILTIN_REVISION_DECLARED_AT,
		};
		const checked = validateRoleRevision({ ...base, fingerprint: fingerprintFoundationValue(base) });
		if (!checked.ok) throw checked.error;
		return checked.value;
	}

	private async resolveDependency(
		name: PromptTaskDependencyName,
		context: ProductPromptDependencySnapshotContextV1,
	): Promise<PromptTaskDependencyResolution> {
		const snapshot = immutableJson(structuredClone(this.options.dependencySnapshot(name, context)));
		const type = DEPENDENCY_FACT_TYPES[name];
		const identity = immutableJson({
			schemaVersion: 1 as const,
			type,
			snapshot,
			...(name === "adapter" ? { providerId: this.options.providerId } : {}),
		});
		const id = `${name}_revision_${factToken(identity)}`;
		const payload = immutableJson({ schemaVersion: 1 as const, type, id, revision: 1 as const, snapshot });
		const fingerprint = fingerprintFoundationValue(payload);
		const existing = await this.existingPayload(type, id);
		if (existing !== undefined && canonicalFoundationJson(existing) !== canonicalFoundationJson(payload)) {
			throw new FoundationError("session_ledger_conflict", `${type} revision ${id} conflicts with its composition snapshot`);
		}
		return {
			reference: {
				schemaVersion: 1,
				type,
				id,
				revision: 1,
				fingerprint,
				...(name === "adapter" ? { providerId: this.options.providerId } : {}),
			},
			payload,
		};
	}

	async resolve(context: ProductPromptDependencySnapshotContextV1): Promise<ProductPromptBindingRevisionFactsV1> {
		const modelProfile = await this.resolveModelProfile(context.model, context.thinkingLevel);
		const roleRevision = await this.resolveRoleRevision(modelProfile);
		const dependencies = Object.fromEntries(PROMPT_TASK_DEPENDENCY_NAMES.map((name) => [name, {
			name,
			revision: 1,
			resolve: () => this.resolveDependency(name, context),
		}])) as unknown as PromptTaskCompositionDependencies;
		return Object.freeze({ roleRevision, modelProfile, dependencies });
	}
}
