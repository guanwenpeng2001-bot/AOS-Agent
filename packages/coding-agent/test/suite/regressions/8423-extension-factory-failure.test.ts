import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ProviderConfig } from "../../../src/core/extensions/types.ts";

const providerConfig = { baseUrl: "https://provider.test/v1", apiKey: "provider-test-key" } satisfies ProviderConfig;

describe("issue #8423 extension factory failure", () => {
	it("discards staged runtime state and disables the captured API", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let capturedApi: ExtensionAPI | undefined;
		let eventCalls = 0;
		await loadExtensionFromFactory(
			(pi) => pi.registerProvider("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);

		await expect(loadExtensionFromFactory(
			(pi) => {
				capturedApi = pi;
				pi.events.on("factory-failure", () => eventCalls++);
				pi.registerFlag("failed-flag", { type: "boolean", default: true });
				pi.unregisterProvider("working-provider");
				pi.registerProvider("failed-provider", providerConfig);
				throw new Error("factory failed");
			},
			process.cwd(),
			eventBus,
			runtime,
			"<failing>",
		)).rejects.toThrow("factory failed");

		eventBus.emit("factory-failure", undefined);
		expect(runtime.flagValues.has("failed-flag")).toBe(false);
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
		expect(eventCalls).toBe(0);
		expect(() => capturedApi?.registerFlag("late", { type: "boolean", default: true })).toThrow(
			'Extension "<failing>" failed to load and its API is no longer active.',
		);
	});
});
