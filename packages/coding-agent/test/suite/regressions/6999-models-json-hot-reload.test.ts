import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@aos-agent/ai";
import { setKeybindings, type TUI } from "@aos-agent/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/policy/auth-storage.ts";
import { KeybindingsManager } from "../../../src/core/runtime/keybindings.ts";
import { ModelRuntime } from "../../../src/core/runtime/model-runtime.ts";
import { SettingsManager } from "../../../src/core/runtime/settings-manager.ts";
import { FileModelsStore } from "../../../src/core/session/models-store.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createModelRegistry, getModelRuntime } from "../../runtime/model-runtime-test-utils.ts";

function observeRefreshRender(): { tui: TUI; renderedAfterRefresh: Promise<void> } {
	let renderCount = 0;
	let resolveRefreshRender = () => {};
	const renderedAfterRefresh = new Promise<void>((resolve) => {
		resolveRefreshRender = resolve;
	});
	return {
		tui: {
			requestRender: () => {
				renderCount++;
				if (renderCount === 2) resolveRefreshRender();
			},
		} as unknown as TUI,
		renderedAfterRefresh,
	};
}

function modelsJson(provider: string, model: string): Record<string, unknown> {
	return {
		providers: {
			[provider]: {
				baseUrl: "https://example.test/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models: [{ id: model }],
			},
		},
	};
}

interface CatalogRefreshGate {
	readonly allStarted: Promise<void>;
	markStarted(providerId: string): void;
	release(): void;
	getAttempts(providerId: string): number;
	wait(): Promise<void>;
}

function createCatalogRefreshGate(providerCount: number): CatalogRefreshGate {
	const attempts = new Map<string, number>();
	let resolveAllStarted = () => {};
	let releaseRefreshes = () => {};
	const allStarted = new Promise<void>((resolve) => {
		resolveAllStarted = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		releaseRefreshes = resolve;
	});
	return {
		allStarted,
		markStarted: (providerId) => {
			attempts.set(providerId, (attempts.get(providerId) ?? 0) + 1);
			if (attempts.size === providerCount) resolveAllStarted();
		},
		release: releaseRefreshes,
		getAttempts: (providerId) => attempts.get(providerId) ?? 0,
		wait: () => blocked,
	};
}

function catalogModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function dynamicCatalogProvider(
	providerId: string,
	modelId: string,
	gate?: CatalogRefreshGate,
): Provider<"openai-completions"> {
	let models: readonly Model<"openai-completions">[] = [];
	const refreshed = catalogModel(providerId, modelId);
	return {
		id: providerId,
		name: providerId,
		auth: {
			apiKey: {
				name: "Fixture key",
				resolve: async () => ({ auth: { apiKey: "fixture-key" }, source: "fixture" }),
			},
		},
		getModels: () => models,
		refreshModels: async (context) => {
			const restored = context.stored?.models
				.filter((model): model is Model<"openai-completions"> => model.api === "openai-completions")
				.filter((model) => model.provider === providerId);
			if (restored) {
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			gate?.markStarted(providerId);
			if (gate) await gate.wait();
			await context.publish({
				persist: { models: [refreshed], checkedAt: Date.now() },
				update: () => {
					models = [refreshed];
				},
			});
		},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("issue #6999 models.json hot reload", () => {
	let tempDir: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("reloads models.json when opening /model", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "aos-models-json-hot-reload-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(modelsJson("old-provider", "old-model")));
		const modelRuntime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsPath));
		expect(modelRuntime.getModel("old-provider", "old-model")).toBeDefined();

		writeFileSync(modelsPath, JSON.stringify(modelsJson("new-provider", "new-model")));
		const { tui, renderedAfterRefresh } = observeRefreshRender();
		const selector = new ModelSelectorComponent(
			tui,
			undefined,
			SettingsManager.inMemory(),
			modelRuntime,
			[],
			() => {},
			() => {},
			"new-model",
		);

		await renderedAfterRefresh;
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("new-model [new-provider]");
		expect(rendered).not.toContain("old-model [old-provider]");
	});

	it("keeps three provider caches across an overlapping refresh and restart", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "aos-model-catalog-round-trip-"));
		const storePath = join(tempDir, "models-store.json");
		const restartStorePath = join(tempDir, "models-store-restart.json");
		const providerModels = [
			["catalog-one", "one-model"],
			["catalog-two", "two-model"],
			["catalog-three", "three-model"],
		] as const;
		const providerIds = providerModels.map(([providerId]) => providerId);
		const gate = createCatalogRefreshGate(providerIds.length);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: new FileModelsStore(storePath),
			allowModelNetwork: false,
		});
		for (const [providerId, modelId] of providerModels) {
			runtime.registerNativeProvider(dynamicCatalogProvider(providerId, modelId, gate));
		}
		await runtime.refresh({ allowNetwork: false, providers: providerIds });

		const first = runtime.refresh({ allowNetwork: true, providers: providerIds });
		await gate.allStarted;
		const overlappingController = new AbortController();
		const overlapping = runtime.refresh({
			allowNetwork: true,
			providers: providerIds,
			signal: overlappingController.signal,
		});
		await Promise.resolve();
		overlappingController.abort();
		await expect(overlapping).resolves.toMatchObject({ aborted: true });
		gate.release();
		await expect(first).resolves.toMatchObject({ aborted: false, errors: new Map() });
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const providerId of providerIds) expect(gate.getAttempts(providerId)).toBe(1);

		copyFileSync(storePath, restartStorePath);
		const restarted = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: new FileModelsStore(restartStorePath),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		for (const [providerId, modelId] of providerModels) {
			restarted.registerNativeProvider(dynamicCatalogProvider(providerId, modelId));
		}
		await restarted.refresh({ allowNetwork: false, providers: providerIds });

		for (const [providerId, modelId] of providerModels) {
			expect(restarted.getModel(providerId, modelId)).toBeDefined();
		}
	});
});
