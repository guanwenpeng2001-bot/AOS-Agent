import {
	createModelProfileRevision,
	InMemoryRoleRegistry,
	type RoleDefinition,
	resolveRoleResolution,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { buildRoleStudioResolutionInput, createRoleStudioPreview } from "../src/core/runtime/role-studio.ts";

const NOW = "2026-09-02T00:00:00.000Z";

const PROFILE = createModelProfileRevision({
	schemaVersion: 1,
	modelProfileId: "profile-role-studio",
	name: "Role Studio profile",
	provider: "test",
	model: "model",
	budget: { tokens: 4_000 },
	revision: 0,
	createdAt: NOW,
});

// Compatibility fixture: it intentionally omits every newer optional Role field.
const LEGACY_ROLE: RoleDefinition = {
	schemaVersion: 1,
	roleId: "legacy-reviewer",
	scope: "global",
	slug: "legacy-reviewer",
	name: "Legacy reviewer",
	description: "Compatible minimal Role",
	revision: 0,
	persona: "Review changes.",
	modelProfileRef: { schemaVersion: 1, type: "model_profile", id: PROFILE.modelProfileId, revision: 0 },
	capabilitySelector: { policy: "named", named: ["read", "search"] },
	skillSelector: { policy: "all" },
	mcpSelector: { policy: "none" },
};

describe("Role Studio", () => {
	it("round-trips Role create, edit, copy, and tombstone delete without changing the registry contract", () => {
		const registry = new InMemoryRoleRegistry({ now: () => NOW });
		const created = registry.create({ definition: LEGACY_ROLE });
		expect(created.ok).toBe(true);
		if (!created.ok) throw created.error;

		const edited = registry.edit({
			roleId: LEGACY_ROLE.roleId,
			scope: "global",
			expectedRevision: created.value.currentRevision.revision,
			patch: { persona: "Review changes and report concrete evidence." },
		});
		expect(edited.ok).toBe(true);
		if (!edited.ok) throw edited.error;
		expect(edited.value.revisions).toHaveLength(2);

		const copied = registry.copy({
			sourceRoleId: LEGACY_ROLE.roleId,
			sourceScope: "global",
			targetRoleId: "project-reviewer",
			targetScope: "project",
			expectedRevision: edited.value.currentRevision.revision,
		});
		expect(copied.ok).toBe(true);

		const deleted = registry.delete({
			roleId: LEGACY_ROLE.roleId,
			scope: "global",
			expectedRevision: edited.value.currentRevision.revision,
			deletedAt: NOW,
		});
		expect(deleted.ok).toBe(true);
		const active = registry.list();
		const withTombstones = registry.list({ includeTombstones: true });
		if (!active.ok) throw active.error;
		if (!withTombstones.ok) throw withTombstones.error;
		expect(active.value).toHaveLength(1);
		expect(withTombstones.value).toHaveLength(2);
	});

	it("uses the production Resolver for the AgentBinding preview", () => {
		const input = { definition: LEGACY_ROLE, modelProfile: PROFILE };
		const studio = createRoleStudioPreview(input);
		const direct = resolveRoleResolution(buildRoleStudioResolutionInput(input));

		expect(direct.ok).toBe(true);
		if (!direct.ok) throw direct.error;
		expect(studio.permission.tightens).toBe(true);
		expect(studio.resolution).toEqual(direct.value);
		expect(studio.resolution?.binding.modelRoute).toEqual({ provider: "test", model: "model" });
	});

	it("blocks a permission preview that widens its managed ceiling", () => {
		const preview = createRoleStudioPreview({
			definition: { ...LEGACY_ROLE, capabilitySelector: { policy: "all" } },
			modelProfile: PROFILE,
			parentCapabilitySelector: { policy: "named", named: ["read"] },
		});

		expect(preview.permission.tightens).toBe(false);
		expect(preview.permission.reason).toContain("cannot widen");
		expect(preview.resolution).toBeUndefined();
	});
});
