import { describe, expect, it } from "vitest";
import {
	buildModelBrokerSettings,
	ModelBrokerSettingsError,
	parseModelBrokerSettings,
} from "../../src/core/runtime/model-broker-settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/runtime/settings-manager.ts";

const COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
const MODELS = [
	{ provider: "anthropic", modelId: "claude-sonnet", cost: COST },
	{ provider: "openai", modelId: "gpt-5", cost: COST },
];

function routeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		candidates: [
			{ provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "medium" },
			{ provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" },
		],
		fallback: { maxAttempts: 2, on: ["provider_unavailable", "transient_provider_error"] },
		budget: { maxModelCalls: 4, maxCostUsd: 2 },
		...overrides,
	};
}

function expectCode(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		if (error instanceof ModelBrokerSettingsError) return error.code;
		throw error;
	}
	throw new Error("expected ModelBrokerSettingsError");
}

describe("ModelBroker settings", () => {
	it("validates and normalizes routes, roleRoutes and budgets", () => {
		const settings = buildModelBrokerSettings({
			global: {
				defaultRoute: "balanced",
				routes: { balanced: routeConfig() },
				roleRoutes: { implementer: "balanced" },
			},
			availableModels: MODELS,
		});

		expect(settings.enabled).toBe(true);
		expect(settings.defaultRoute).toBe("balanced");
		expect(settings.roleRoutes).toEqual({ implementer: "balanced" });
		expect(settings.routes.balanced.candidates[0]).toMatchObject({
			provider: "anthropic",
			modelId: "claude-sonnet",
			order: 0,
		});
		expect(settings.routes.balanced.fallback.maxAttempts).toBe(2);
		expect(settings.routes.balanced.budget.maxCostUsd).toBe(2);
	});

	it("rejects secrets, endpoints and unknown fields", () => {
		expect(
			expectCode(() =>
				parseModelBrokerSettings({
					routes: {
						balanced: {
							candidates: [{ provider: "anthropic", modelId: "claude-sonnet", apiKey: "secret" }],
						},
					},
				}),
			),
		).toBe("model_route_invalid");
		expect(
			expectCode(() =>
				parseModelBrokerSettings({
					routes: {
						balanced: {
							candidates: [{ provider: "anthropic", modelId: "claude-sonnet" }],
							endpoint: "https://example.invalid",
						},
					},
				}),
			),
		).toBe("model_route_invalid");
		expect(expectCode(() => parseModelBrokerSettings({ routes: { "bad route": routeConfig() } }))).toBe(
			"model_route_invalid",
		);
	});

	it("rejects duplicate and unavailable candidates", () => {
		expect(
			expectCode(() =>
				buildModelBrokerSettings({
					global: {
						routes: {
							balanced: {
								candidates: [
									{ provider: "anthropic", modelId: "claude-sonnet" },
									{ provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "high" },
								],
							},
						},
					},
					availableModels: MODELS,
				}),
			),
		).toBe("model_route_invalid");
		expect(
			expectCode(() =>
				buildModelBrokerSettings({
					global: {
						routes: { balanced: { candidates: [{ provider: "google", modelId: "gemini" }] } },
					},
					availableModels: MODELS,
				}),
			),
		).toBe("model_route_unavailable");
	});

	it("rejects maxCostUsd when any candidate has unknown cost", () => {
		expect(
			expectCode(() =>
				buildModelBrokerSettings({
					global: { routes: { balanced: routeConfig() } },
					availableModels: [
						{ provider: "anthropic", modelId: "claude-sonnet", cost: COST },
						{ provider: "openai", modelId: "gpt-5" },
					],
				}),
			),
		).toBe("model_route_invalid");
		expect(expectCode(() => buildModelBrokerSettings({ global: { routes: { balanced: routeConfig() } } }))).toBe(
			"model_route_invalid",
		);
	});

	it("uses a trusted project default and ignores an untrusted one with diagnostics", () => {
		const global = {
			defaultRoute: "balanced",
			routes: { balanced: { candidates: MODELS.map(({ provider, modelId }) => ({ provider, modelId })) } },
		};
		const trusted = buildModelBrokerSettings({
			global,
			project: { defaultRoute: "balanced" },
			projectTrusted: true,
			availableModels: MODELS,
		});
		expect(trusted.defaultRoute).toBe("balanced");

		const untrusted = buildModelBrokerSettings({
			global,
			project: { defaultRoute: "project-route", routes: { "project-route": routeConfig() } },
			projectTrusted: false,
			availableModels: MODELS,
		});
		expect(untrusted.defaultRoute).toBe("balanced");
		expect(untrusted.diagnostics).toMatchObject([
			{ scope: "project", trusted: false, ignored: true, reason: "project_untrusted" },
		]);
	});

	it("produces a stable safe revision and preserves empty legacy behavior", () => {
		const first = buildModelBrokerSettings({
			global: { routes: { balanced: { candidates: [{ provider: "anthropic", modelId: "claude-sonnet" }] } } },
			availableModels: MODELS,
		});
		const second = buildModelBrokerSettings({
			global: { routes: { balanced: { candidates: [{ modelId: "claude-sonnet", provider: "anthropic" }] } } },
			availableModels: MODELS,
		});
		expect(first.configRevision).toBe(second.configRevision);
		expect(first.configRevision).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(first)).not.toContain("secret");

		const empty = buildModelBrokerSettings({ global: undefined });
		expect(empty).toMatchObject({ enabled: false, routes: {}, roleRoutes: {}, diagnostics: [] });
		expect(empty.defaultRoute).toBeUndefined();
	});

	it("integrates trust-aware settings without changing SettingsManager construction", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				modelBroker: {
					defaultRoute: "balanced",
					routes: { balanced: { candidates: [{ provider: "anthropic", modelId: "claude-sonnet" }] } },
				},
			}),
		);
		storage.withLock("project", () => JSON.stringify({ modelBroker: { defaultRoute: "project-route" } }));

		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		const settings = manager.getModelBrokerSettings({ availableModels: MODELS });
		expect(settings.defaultRoute).toBe("balanced");
		expect(settings.diagnostics[0]).toMatchObject({ ignored: true, trusted: false });

		const writable = SettingsManager.inMemory();
		writable.setModelBrokerSettings({
			defaultRoute: "balanced",
			routes: { balanced: { candidates: [{ provider: "anthropic", modelId: "claude-sonnet" }] } },
		});
		await writable.flush();
		expect(writable.getModelBrokerSettings({ availableModels: MODELS }).defaultRoute).toBe("balanced");
	});
});
