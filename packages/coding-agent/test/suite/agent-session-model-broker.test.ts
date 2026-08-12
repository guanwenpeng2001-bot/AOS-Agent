import { fauxAssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	MODEL_ATTEMPT_CUSTOM_TYPE,
	MODEL_BINDING_CUSTOM_TYPE,
	parseModelAttemptEntry,
	parseModelBindingEntry,
} from "../../src/core/model-broker-ledger.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession ModelBroker integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists safe binding and terminal attempt facts around an actual model call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("hello");

		const entries = harness.sessionManager.getEntries();
		const bindingEntry = entries.find((entry) => entry.type === "custom" && entry.customType === MODEL_BINDING_CUSTOM_TYPE);
		const attemptEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === MODEL_ATTEMPT_CUSTOM_TYPE);
		const binding = bindingEntry === undefined ? undefined : parseModelBindingEntry(bindingEntry.data);
		const attempts = attemptEntries
			.map((entry) => parseModelAttemptEntry(entry.data))
			.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

		expect(binding).toMatchObject({ mode: "direct", fallback: { maxAttempts: 1, on: [] } });
		expect(binding?.candidates[0]?.model).toMatchObject({ provider: harness.getModel().provider, modelId: harness.getModel().id });
		expect(attempts.map((attempt) => attempt.status)).toEqual(["completed"]);
		expect(JSON.stringify(entries)).not.toContain("apiKey");
		expect(harness.session.modelBroker.getBindings()).toHaveLength(1);
	});
});
