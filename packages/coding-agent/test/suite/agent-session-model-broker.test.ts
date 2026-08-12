import { fauxAssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelBroker } from "../../src/core/model-broker.ts";
import {
	foldModelAttemptEntries,
	MODEL_BINDING_CUSTOM_TYPE,
	parseModelBindingEntry,
} from "../../src/core/model-broker-ledger.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
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
		const customEntries = entries.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom",
		);
		const bindingEntry = customEntries.find((entry) => entry.customType === MODEL_BINDING_CUSTOM_TYPE);
		const binding = bindingEntry === undefined ? undefined : parseModelBindingEntry(bindingEntry.data);
		const attempts = foldModelAttemptEntries(entries);

		expect(binding).toMatchObject({ mode: "direct", fallback: { maxAttempts: 1, on: [] } });
		expect(binding?.candidates[0]?.model).toMatchObject({
			provider: harness.getModel().provider,
			modelId: harness.getModel().id,
		});
		expect([...attempts.values()].map((attempt) => attempt.status)).toEqual(["completed"]);
		expect(JSON.stringify(entries)).not.toContain("apiKey");
		expect(harness.session.modelBroker.getBindings()).toHaveLength(1);
	});

	it("retries a transient route failure with a fresh immutable context binding", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			modelBroker: new ModelBroker({
				routes: {
					fallback: {
						id: "fallback",
						candidates: [
							{ provider: "faux", id: "faux-1" },
							{ provider: "faux", id: "faux-2" },
						],
						fallback: { maxAttempts: 2, on: ["provider_unavailable"] },
					},
				},
				defaultRoute: "fallback",
			}),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 unavailable" }),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("hello");

		const attempts = [...foldModelAttemptEntries(harness.sessionManager.getEntries()).values()];
		expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
		expect(attempts.map((attempt) => attempt.candidate.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(attempts[0]?.contextSnapshotId).toBeDefined();
		expect(attempts[1]?.contextSnapshotId).toBeDefined();
		expect(attempts[0]?.contextSnapshotId).not.toBe(attempts[1]?.contextSnapshotId);
		expect(harness.session.modelBroker.getBindings()).toHaveLength(1);
	});
});
