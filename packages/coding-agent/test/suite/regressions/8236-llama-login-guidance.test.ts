import { describe, expect, it } from "vitest";
import { llamaCppPostLoginGuidance } from "../../../src/modes/interactive/interactive-mode.ts";

describe("issue #8236 llama.cpp login guidance", () => {
	it("directs empty catalogs to load a model before selecting it", () => {
		expect(llamaCppPostLoginGuidance("Login succeeded", 0)).toBe(
			"Login succeeded. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.",
		);
	});
});
