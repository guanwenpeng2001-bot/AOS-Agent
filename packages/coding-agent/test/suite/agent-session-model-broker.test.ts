import type { AgentTool } from "@aos-agent/agent-core";
import { fakeAssistantMessage, fakeToolCall } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { ModelBroker } from "../../src/core/model-broker.ts";
import {
	foldModelAttemptEntries,
	MODEL_BINDING_CUSTOM_TYPE,
	parseModelBindingEntry,
} from "../../src/core/model-broker-ledger.ts";
import { CONTEXT_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/session/context-engine.ts";
import type { SessionEntry } from "../../src/core/session/manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession ModelBroker integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists safe binding and terminal attempt facts around an actual model call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fakeAssistantMessage("ok")]);

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
			models: [{ id: "fake-1" }, { id: "fake-2" }],
			modelBroker: new ModelBroker({
				routes: {
					fallback: {
						id: "fallback",
						candidates: [
							{ provider: "fake", id: "fake-1" },
							{ provider: "fake", id: "fake-2" },
						],
						fallback: { maxAttempts: 2, on: ["provider_unavailable"] },
					},
				},
				defaultRoute: "fallback",
			}),
		});
		harnesses.push(harness);
		harness.setResponses([
			fakeAssistantMessage([], { stopReason: "error", errorMessage: "503 unavailable" }),
			fakeAssistantMessage("ok"),
		]);

		await harness.session.prompt("hello");

		const attempts = [...foldModelAttemptEntries(harness.sessionManager.getEntries()).values()];
		expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
		expect(attempts.map((attempt) => attempt.candidate.modelId)).toEqual(["fake-1", "fake-2"]);
		expect(attempts[0]?.contextSnapshotId).toBeDefined();
		expect(attempts[1]?.contextSnapshotId).toBeDefined();
		expect(attempts[0]?.contextSnapshotId).not.toBe(attempts[1]?.contextSnapshotId);
		expect(harness.session.modelBroker.getBindings()).toHaveLength(1);
	});

	it("retains an over-budget response and records the completed attempt", async () => {
		const harness = await createHarness({
			modelBroker: new ModelBroker({
				routes: {
					budgeted: {
						candidates: [{ provider: "fake", id: "fake-1" }],
						budget: { maxOutputTokens: 0 },
					},
				},
				defaultRoute: "budgeted",
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fakeAssistantMessage("retained")]);

		await harness.session.prompt("hello");

		const assistant = harness.session.messages.at(-1);
		expect(assistant).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "The operation outcome is unknown after a possible side effect.",
			content: [{ type: "text", text: "" }],
		});
		const attempts = [...foldModelAttemptEntries(harness.sessionManager.getEntries()).values()];
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			status: "completed",
			summary: "Model budget exceeded; subsequent calls are blocked.",
		});
		expect(harness.fake.state.callCount).toBe(1);
	});

	it("blocks a later model-loop call after the run budget is exhausted", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: typeof params === "object" && params !== null && "text" in params ? String(params.text) : "" }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [echoTool],
			modelBroker: new ModelBroker({
				routes: {
					limited: {
						candidates: [{ provider: "fake", id: "fake-1" }],
						budget: { maxModelCalls: 1 },
					},
				},
				defaultRoute: "limited",
			}),
		});
		harnesses.push(harness);
		harness.setResponses([
			fakeAssistantMessage(fakeToolCall("echo", { text: "first" }), { stopReason: "toolUse" }),
			fakeAssistantMessage("must not be dispatched"),
		]);

		await harness.session.prompt("hello");

		expect(harness.fake.state.callCount).toBe(1);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Model budget exceeded.",
		});
		const attempts = [...foldModelAttemptEntries(harness.sessionManager.getEntries()).values()];
		expect(attempts.map((attempt) => attempt.failureCategory)).toContain("model_budget_exceeded");
	});

	it("writes the Context snapshot after the started attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fakeAssistantMessage("ok")]);

		await harness.session.prompt("hello");

		const entries = harness.sessionManager.getEntries();
		const startedAttemptIndex = entries.findIndex(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "model.attempt" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				"attempt" in entry.data &&
				(entry.data as { attempt?: { status?: string } }).attempt?.status === "started",
		);
		const snapshotIndex = entries.findIndex(
			(entry) => entry.type === "custom" && entry.customType === CONTEXT_SNAPSHOT_CUSTOM_TYPE,
		);
		expect(startedAttemptIndex).toBeGreaterThanOrEqual(0);
		expect(snapshotIndex).toBeGreaterThan(startedAttemptIndex);
	});
});
