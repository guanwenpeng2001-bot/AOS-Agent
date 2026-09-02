import { describe, expect, it } from "vitest";
import { parseModelBrokerSettings } from "../../src/core/runtime/model-broker-settings.ts";

describe("ModelBroker service tier settings", () => {
	it("preserves an explicit gateway service tier and rejects implicit values", () => {
		const settings = parseModelBrokerSettings({
			routes: {
				gateway: {
					candidates: [{
						provider: "openai",
						modelId: "gpt-test",
						thinkingLevel: "high",
						serviceTier: "priority",
					}],
				},
			},
		});
		expect(settings.routes?.gateway?.candidates[0]).toMatchObject({ serviceTier: "priority" });
		expect(() => parseModelBrokerSettings({
			routes: {
				gateway: {
					candidates: [{ provider: "openai", modelId: "gpt-test", serviceTier: "" }],
				},
			},
		})).toThrow("serviceTier must be an explicit bounded string");
	});
});
