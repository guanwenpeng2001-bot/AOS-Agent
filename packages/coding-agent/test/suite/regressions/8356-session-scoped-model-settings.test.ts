import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #8356 session-scoped model settings", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("does not rewrite global defaults when model or thinking changes", async () => {
		harness = await createHarness({
			models: [
				{ id: "fake-1", reasoning: true },
				{ id: "fake-2", reasoning: true },
			],
		});
		const beforeProvider = harness.settingsManager.getDefaultProvider();
		const beforeModel = harness.settingsManager.getDefaultModel();
		const beforeThinking = harness.settingsManager.getDefaultThinkingLevel();

		await harness.session.setModel(harness.getModel("fake-2")!);
		harness.session.setThinkingLevel("high");

		expect(harness.session.model?.id).toBe("fake-2");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultProvider()).toBe(beforeProvider);
		expect(harness.settingsManager.getDefaultModel()).toBe(beforeModel);
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(beforeThinking);
	});
});
