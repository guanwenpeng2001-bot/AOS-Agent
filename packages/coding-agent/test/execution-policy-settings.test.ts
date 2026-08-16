import { describe, expect, it } from "vitest";
import {
	buildExecutionPolicySettings,
	ExecutionPolicySettingsError,
	DEFAULT_REGISTERED_SANDBOX_PROVIDER_IDS,
} from "../src/core/execution-policy-settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const hostProfile = {
	id: "host-safe",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "ask", inheritEnvironment: false, allowEnvironment: ["PATH", "LANG"] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
} as const;

const sandboxProfile = {
	...hostProfile,
	id: "workspace-safe",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
} as const;

function globalSettings(defaultProfile = "host-safe") {
	return {
		executionPolicy: {
			defaultProfile,
			profiles: {
				"host-safe": hostProfile,
				"workspace-safe": sandboxProfile,
			},
		},
	};
}

function expectPolicyError(action: () => unknown, code: string): void {
	expect(action).toThrow(ExecutionPolicySettingsError);
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code });
	}
}

describe("execution policy settings", () => {
	it("keeps legacy as the immutable default and selects a named Run profile", () => {
		const legacy = buildExecutionPolicySettings({ policyProfile: "legacy" });

		expect(legacy.defaultProfile).toBe("legacy");
		expect(legacy.selectedProfileId).toBe("legacy");
		expect(legacy.selectedProfile.enforcement).toBe("legacy");
		expect(Object.isFrozen(legacy)).toBe(true);
		expect(Object.isFrozen(legacy.selectedProfile)).toBe(true);

		const selected = buildExecutionPolicySettings({
			global: globalSettings(),
			policyProfile: "workspace-safe",
			registeredProviderIds: [...DEFAULT_REGISTERED_SANDBOX_PROVIDER_IDS, "fake-sandbox"],
		});
		expect(selected.defaultProfile).toBe("host-safe");
		expect(selected.selectedProfileId).toBe("workspace-safe");
		expect(selected.selectedProfile.enforcement).toBe("sandbox");
	});

	it("merges system defaults, global profiles, and a trusted project narrowing", () => {
		const result = buildExecutionPolicySettings({
			system: {
				executionPolicy: {
					defaultProfile: "host-safe",
					profiles: { "host-safe": hostProfile },
				},
			},
			global: {
				executionPolicy: {
					profiles: { "workspace-safe": sandboxProfile },
				},
			},
			project: {
				executionPolicy: {
					defaultProfile: "workspace-safe",
					profiles: { "workspace-safe": { network: { action: "deny" }, process: { action: "deny" } } },
				},
			},
			projectTrusted: true,
			registeredProviderIds: ["fake-sandbox"],
		});

		expect(result.globalDefaultProfile).toBe("host-safe");
		expect(result.defaultProfile).toBe("workspace-safe");
		expect(result.selectedProfile.process.action).toBe("deny");
		expect(result.selectedProfile.network.action).toBe("deny");
	});

	it("allows an untrusted project to narrow the selected profile but not widen it", () => {
		const narrowed = buildExecutionPolicySettings({
			global: globalSettings(),
			projectTrusted: false,
			registeredProviderIds: ["fake-sandbox"],
			project: {
				executionPolicy: {
					defaultProfile: "host-safe",
					profiles: { "host-safe": { process: { action: "deny" } } },
				},
			},
		});
		expect(narrowed.selectedProfile.process.action).toBe("deny");
		expect(narrowed.diagnostics[0]).toMatchObject({ trusted: false, reason: "project_untrusted" });

		expectPolicyError(
			() =>
				buildExecutionPolicySettings({
					global: globalSettings(),
					projectTrusted: false,
					registeredProviderIds: ["fake-sandbox"],
					project: {
						executionPolicy: {
							defaultProfile: "host-safe",
							profiles: { "host-safe": { network: { action: "allow", allowDestinations: ["example.invalid"] } } },
						},
					},
				}),
			"policy_profile_untrusted",
		);
	});

	it("rejects malformed or unregistered profiles and providers", () => {
		expectPolicyError(
			() =>
				buildExecutionPolicySettings({
					global: { executionPolicy: { defaultProfile: "missing", profiles: {} } },
				}),
			"policy_profile_not_found",
		);
		expectPolicyError(
			() =>
				buildExecutionPolicySettings({
					global: {
						executionPolicy: {
							profiles: {
								bad: { ...hostProfile, id: "bad", process: { action: "maybe", inheritEnvironment: false, allowEnvironment: [] } },
							},
						},
					},
				}),
			"policy_settings_invalid",
		);
		expectPolicyError(
			() =>
				buildExecutionPolicySettings({
					global: { executionPolicy: { profiles: { ...({ unknown: { ...sandboxProfile, id: "unknown", sandboxProvider: "npm:evil" } }) } } },
				}),
			"policy_settings_invalid",
		);
	});

	it("rejects project provider/package, credential, parent-environment, and URL injection", () => {
		const cases: ReadonlyArray<Record<string, unknown>> = [
			{ providerPackage: "npm:evil" },
			{ token: "secret-value" },
			{ process: { inheritEnvironment: true } },
			{ network: { allowDestinations: ["https://evil.invalid"] } },
		];
		for (const narrowing of cases) {
			expectPolicyError(
				() =>
					buildExecutionPolicySettings({
						global: globalSettings(),
						projectTrusted: true,
						project: { executionPolicy: { profiles: { "host-safe": narrowing } } },
					}),
				"policy_profile_untrusted",
			);
		}
	});

	it("uses the existing SettingsManager project-trust state without another trust store", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(globalSettings()));
		storage.withLock("project", () => JSON.stringify({ executionPolicy: { defaultProfile: "host-safe", profiles: { "host-safe": { process: { action: "deny" } } } } }));

		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		const providerOptions = { registeredProviderIds: ["fake-sandbox"] };
		expect(manager.getExecutionPolicySettings(providerOptions).projectTrusted).toBe(false);
		expect(manager.getExecutionPolicySettings(providerOptions).selectedProfile.process.action).toBe("deny");

		manager.setProjectTrusted(true);
		expect(manager.getExecutionPolicySettings(providerOptions).projectTrusted).toBe(true);
		expect(manager.getExecutionPolicySettings(providerOptions).selectedProfile.process.action).toBe("deny");
	});

	it("parses profiles with MCP auth and content approval keys", () => {
		const result = buildExecutionPolicySettings({
			global: {
				executionPolicy: {
					defaultProfile: "content-safe",
					profiles: {
						"content-safe": {
							...hostProfile,
							id: "content-safe",
							approvals: {
								...hostProfile.approvals,
								mcp: "ask",
								resource: "ask",
								prompt: "ask",
								context: "deny",
							},
						},
					},
				},
			},
		});
		expect(result.selectedProfile.approvals).toMatchObject({
			mcp: "ask",
			resource: "ask",
			prompt: "ask",
			context: "deny",
		});
		// Unset optional approval keys stay absent in the frozen profile.
		expect(result.selectedProfile.approvals).not.toHaveProperty("sandbox");
	});
});
