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

	it("enforces service tier length, exact whitespace, control characters, type, and candidate shape", () => {
		const parseCandidate = (candidate: Record<string, unknown>) => parseModelBrokerSettings({
			routes: {
				gateway: {
					candidates: [{ provider: "openai", modelId: "gpt-test", ...candidate }],
				},
			},
		});
		const boundary = "x".repeat(128);

		expect(parseCandidate({ serviceTier: boundary }).routes?.gateway?.candidates[0]).toMatchObject({
			serviceTier: boundary,
		});
		for (const serviceTier of [
			"x".repeat(129),
			" priority",
			"priority ",
			"pri\u0000ority",
			"priority\u007f",
			42,
		]) {
			expect(() => parseCandidate({ serviceTier })).toThrow("serviceTier must be an explicit bounded string");
		}
		expect(() => parseCandidate({ serviceTier: "priority", unexpected: true })).toThrow(
			"unknown ModelBroker settings field",
		);
	});
});
