import type { TUI } from "@aos-agent/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("matches prefix searches for the configured default", async () => {
		harness = await createHarness({ models: [{ id: "fake-1" }, { id: "fake-2" }] });
		harness.settingsManager.setDefaultModelAndProvider(harness.getModel("fake-2")!.provider, "fake-2");
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("fake-1"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		(selector as unknown as { filterModels(query: string): void }).filterModels("def");

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("fake-2");
		expect(rendered).not.toContain("fake-1");
	});
});
