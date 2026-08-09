import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createAosCodingAgentHarness } from "./aos-harness.ts";

const aosCodingAgentHarness = createAosCodingAgentHarness({ noTools: "all" });

describeEval("AOS Agent smoke", { harness: aosCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.AOS_AGENT_PROVIDER);
		expect(result.usage.model).toBe(process.env.AOS_AGENT_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
