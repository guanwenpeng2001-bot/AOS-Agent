import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentHarness, type HarnessCompatibilityWriter } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

describe("AgentHarness compatibility state", () => {
	it("reports pending external messages until their compatibility write settles", async () => {
		let releaseWrite: (() => void) | undefined;
		const pendingWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const compatibilityWriter: HarnessCompatibilityWriter = {
			recordMessage: () => pendingWrite,
			recordCustomEntry: () => "custom-entry",
			setSessionName: () => undefined,
			setSessionLabel: () => undefined,
		};
		const harness = AgentHarness.createUnrestored({
			session: new Session(new InMemorySessionStorage({ id: "compatibility-state", createdAt: 1 })),
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			compatibilityWriter,
		});

		const write = harness.recordExternalMessage({
			role: "user",
			content: [{ type: "text", text: "external" }],
			timestamp: 1,
		});
		expect(harness.hasPendingExternalMessages).toBe(true);

		releaseWrite?.();
		await write;
		expect(harness.hasPendingExternalMessages).toBe(false);
		await harness.close();
	});
});
