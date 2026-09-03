import {
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type ModelProfile,
	type RevisionReference,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import {
	EXTERNAL_MODEL_PROJECTION_FIELDS,
	createExternalModelProjection,
	isExternalResolvedModelProjection,
	projectExternalModelForExecution,
	translateExternalModelProjection,
	type ExternalModelFieldSupport,
	type ExternalModelProjectionField,
	type ExternalModelSupportMatrix,
} from "../../src/core/connector/model-projection.ts";

const NOW = "2026-08-27T00:00:00.000Z";

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function modelProfile(options: { readonly omitEffort?: boolean; readonly omitServiceTier?: boolean } = {}): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile-external-model",
		provider: "host-provider",
		model: "namespace/model-primary",
		...(options.omitEffort ? {} : { effort: "high" }),
		...(options.omitServiceTier ? {} : { serviceTier: "priority" }),
		fallback: [{ provider: "backup-provider", model: "namespace/model-backup" }],
		budget: { modelCalls: 2 },
		revision: 1,
		createdAt: NOW,
	});
}

function binding(profile: ModelProfile = modelProfile()): AgentBinding {
	const task = createTaskEnvelope({
		 schemaVersion: 1,
		taskId: "task-external-model",
		goalId: "goal-external-model",
		goal: "Project a canonical model binding",
		workspace: "workspace-external-model",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { modelCalls: 2 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!task.ok) throw task.error;
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-external-model",
			scope: "project",
			slug: "external-model",
			name: "External model",
			description: "External model projection fixture",
			revision: 1,
			persona: "Execute the task.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: profile.modelProfileId,
				revision: profile.revision,
			},
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const resolved = resolveAgentBinding({
		task: task.value,
		roleRevision: role,
		modelProfile: profile,
		contextRevision: immutableFact("external_agent_binding", "external-binding-1"),
		capabilityRevision: immutableFact("capability_binding", "capability-binding-1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-binding-1"),
		policyRevision: immutableFact("policy_binding", "policy-binding-1"),
		newBindingId: "binding-external-model",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function exactSupport(
	targetField: string,
	options: {
		readonly accepts?: (value: string) => boolean;
		readonly translate?: (value: string) => { readonly kind: "exact"; readonly value: string } | undefined;
	} = {},
): ExternalModelFieldSupport {
	return {
		supported: true,
		targetField,
		accepts: options.accepts ?? (() => true),
		translate: options.translate ?? ((value) => ({ kind: "exact", value })),
	};
}

function exactMatrix(overrides: Partial<Record<ExternalModelProjectionField, ExternalModelFieldSupport>> = {}): ExternalModelSupportMatrix {
	return {
		provider: exactSupport("provider_name"),
		model: exactSupport("model_name"),
		effort: exactSupport("reasoning_effort"),
		serviceTier: exactSupport("service_tier"),
		fallbackDecision: exactSupport("fallback_decision"),
		bindingDigest: exactSupport("binding_digest"),
		...overrides,
	};
}

describe("execution-class-aware external model gate", () => {
	it("never resolves a local binding for none or agent_owned", async () => {
		let resolveCalls = 0;
		const bindingSource = {
			resolve(): AgentBinding {
				resolveCalls += 1;
				throw new Error("local ModelBroker must not be touched");
			},
		};

		await expect(projectExternalModelForExecution({ modelAccess: "none", bindingSource })).resolves.toEqual({
			ok: true,
			status: "not_required",
			modelAccess: "none",
		});
		await expect(projectExternalModelForExecution({ modelAccess: "agent_owned", bindingSource })).resolves.toEqual({
			ok: true,
			status: "not_required",
			modelAccess: "agent_owned",
		});
		expect(resolveCalls).toBe(0);
	});

	it("requires and resolves one canonical AgentBinding for aos_gateway", async () => {
		const currentBinding = binding();
		let resolveCalls = 0;
		const result = await projectExternalModelForExecution({
			modelAccess: "aos_gateway",
			bindingSource: {
				resolve: () => {
					resolveCalls += 1;
					return currentBinding;
				},
			},
			fallbackDecision: { kind: "primary", reason: "fallback_not_used" },
		});

		expect(resolveCalls).toBe(1);
		expect(result).toMatchObject({
			ok: true,
			status: "projected",
			modelAccess: "aos_gateway",
			projection: {
				provider: "host-provider",
				model: "namespace/model-primary",
				effort: "high",
				serviceTier: "priority",
				fallbackDecision: { kind: "primary", reason: "fallback_not_used" },
				bindingDigest: currentBinding.fingerprint,
			},
		});
		if (result.ok && result.status === "projected") {
			expect(isExternalResolvedModelProjection(result.projection)).toBe(true);
			expect(Object.isFrozen(result.projection)).toBe(true);
		}
	});

	it("keeps the frozen ModelBinding digest distinct from the execution AgentBinding", async () => {
		const modelBindingDigest = { algorithm: "sha256" as const, value: "b".repeat(64) };
		const result = await projectExternalModelForExecution({
			modelAccess: "aos_gateway",
			bindingSource: {
				resolve: () => ({ modelRoute: binding().modelRoute, fingerprint: modelBindingDigest }),
			},
			fallbackDecision: { kind: "primary", reason: "fallback_not_used" },
		});
		expect(result).toMatchObject({
			ok: true,
			status: "projected",
			projection: { bindingDigest: modelBindingDigest },
		});
		expect(binding().fingerprint.value).not.toBe(modelBindingDigest.value);
	});

	it("fails closed when gateway binding facts are missing, invalid, or unresolved", async () => {
		await expect(projectExternalModelForExecution({ modelAccess: "aos_gateway" })).resolves.toMatchObject({
			ok: false,
			error: { code: "external_binding_invalid", reasonCode: "model_binding_required" },
		});
		await expect(
			projectExternalModelForExecution({
				modelAccess: "aos_gateway",
				bindingSource: { resolve: () => Promise.reject(new Error("raw provider detail")) },
				fallbackDecision: { kind: "disabled", reason: "fallback_disabled" },
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "external_binding_invalid", reasonCode: "model_binding_invalid" },
		});

		const current = binding();
		const drifted = { ...current, modelRoute: { ...current.modelRoute, model: "changed-model" } };
		expect(createExternalModelProjection(drifted, { kind: "disabled", reason: "fallback_disabled" })).toMatchObject({
			ok: false,
			error: { code: "external_binding_invalid", reasonCode: "model_binding_invalid" },
		});
	});

	it("requires explicit effort, service tier, and a valid fallback decision", () => {
		const withoutEffort = binding(modelProfile({ omitEffort: true }));
		expect(createExternalModelProjection(withoutEffort, { kind: "primary", reason: "fallback_not_used" })).toMatchObject({
			ok: false,
			error: { reasonCode: "model_field_missing", field: "effort" },
		});
		const withoutTier = binding(modelProfile({ omitServiceTier: true }));
		expect(createExternalModelProjection(withoutTier, { kind: "primary", reason: "fallback_not_used" })).toMatchObject({
			ok: false,
			error: { reasonCode: "model_field_missing", field: "serviceTier" },
		});
		expect(
			createExternalModelProjection(binding(), {
				kind: "fallback",
				reason: "provider_unavailable",
				candidateIndex: 2,
			}),
		).toMatchObject({ ok: false, error: { reasonCode: "model_fallback_invalid" } });
	});

	it("projects the exact frozen fallback candidate with an explicit decision", () => {
		const result = createExternalModelProjection(binding(), {
			kind: "fallback",
			reason: "provider_unavailable",
			candidateIndex: 1,
		});
		expect(result).toMatchObject({
			ok: true,
			projection: {
				provider: "backup-provider",
				model: "namespace/model-backup",
				effort: "high",
				serviceTier: "priority",
				fallbackDecision: { kind: "fallback", reason: "provider_unavailable", candidateIndex: 1 },
			},
		});
	});
});

describe("connector model support matrix", () => {
	it("validates and translates every canonical field exactly", () => {
		const projected = createExternalModelProjection(binding(), { kind: "primary", reason: "fallback_not_used" });
		if (!projected.ok) throw new Error("expected projection");
		const visited: string[] = [];
		const matrix = exactMatrix(
			Object.fromEntries(
				EXTERNAL_MODEL_PROJECTION_FIELDS.map((field) => [
					field,
					exactSupport(`target_${field}`, {
						accepts: () => {
							visited.push(`accept:${field}`);
							return true;
						},
						translate: (value) => {
							visited.push(`translate:${field}`);
							return { kind: "exact", value: `mapped:${value}` };
						},
					}),
				]),
			) as Partial<Record<ExternalModelProjectionField, ExternalModelFieldSupport>>,
		);

		const result = translateExternalModelProjection(projected.projection, matrix);
		expect(result.ok).toBe(true);
		expect(visited).toEqual(EXTERNAL_MODEL_PROJECTION_FIELDS.flatMap((field) => [`accept:${field}`, `translate:${field}`]));
		if (result.ok) {
			expect(Object.keys(result.translation.fields)).toEqual(EXTERNAL_MODEL_PROJECTION_FIELDS);
			expect(result.translation.sourceBindingDigest).toEqual(projected.projection.bindingDigest);
			expect(result.translation.fields.provider).toEqual({
				targetField: "target_provider",
				value: "mapped:host-provider",
			});
		}
	});

	it("fails closed for missing, unsupported, duplicated, rejected, or implicit translations", () => {
		const projected = createExternalModelProjection(binding(), { kind: "disabled", reason: "fallback_disabled" });
		if (!projected.ok) throw new Error("expected projection");

		expect(translateExternalModelProjection(projected.projection, { ...exactMatrix(), effort: undefined })).toMatchObject({
			ok: false,
			error: { reasonCode: "model_support_matrix_invalid" },
		});
		expect(
			translateExternalModelProjection(projected.projection, exactMatrix({ model: { supported: false } })),
		).toMatchObject({ ok: false, error: { reasonCode: "model_field_unsupported", field: "model" } });
		expect(
			translateExternalModelProjection(
				projected.projection,
				exactMatrix({ serviceTier: exactSupport("provider_name") }),
			),
		).toMatchObject({ ok: false, error: { reasonCode: "model_support_matrix_invalid", field: "serviceTier" } });
		expect(
			translateExternalModelProjection(
				projected.projection,
				exactMatrix({ effort: exactSupport("reasoning_effort", { accepts: () => false }) }),
			),
		).toMatchObject({ ok: false, error: { reasonCode: "model_field_unsupported", field: "effort" } });
		expect(
			translateExternalModelProjection(
				projected.projection,
				exactMatrix({ model: exactSupport("model_name", { translate: () => ({ kind: "exact", value: "default" }) }) }),
			),
		).toMatchObject({ ok: false, error: { reasonCode: "model_field_translation_failed", field: "model" } });
	});
});
