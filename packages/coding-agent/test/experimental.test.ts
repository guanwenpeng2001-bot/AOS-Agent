import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalExperimental = process.env.AOS_AGENT_EXPERIMENTAL;

	afterEach(() => {
		if (originalExperimental === undefined) {
			delete process.env.AOS_AGENT_EXPERIMENTAL;
		} else {
			process.env.AOS_AGENT_EXPERIMENTAL = originalExperimental;
		}
	});

	it("returns false when AOS_AGENT_EXPERIMENTAL is unset", () => {
		delete process.env.AOS_AGENT_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AOS_AGENT_EXPERIMENTAL is empty", () => {
		process.env.AOS_AGENT_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when AOS_AGENT_EXPERIMENTAL is set to 1", () => {
		process.env.AOS_AGENT_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when AOS_AGENT_EXPERIMENTAL is set to 0", () => {
		process.env.AOS_AGENT_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AOS_AGENT_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.AOS_AGENT_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
