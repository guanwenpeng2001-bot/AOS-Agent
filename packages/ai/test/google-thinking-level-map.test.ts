import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamGoogle } from "../src/api/google-generative-ai.ts";
import { resolveGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { streamSimple as streamVertex } from "../src/api/google-vertex.ts";
import type { Context, Model, ThinkingLevelMap } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

function model<T extends "google-generative-ai" | "google-vertex">(
	api: T,
	thinkingLevelMap: ThinkingLevelMap,
): Model<T> {
	return {
		id: "gemini-3-flash",
		name: "Gemini",
		api,
		provider: `test-${api}`,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function capturePayload(
	providerModel: Model<"google-generative-ai"> | Model<"google-vertex">,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const options = {
		apiKey: "test",
		reasoning: "high" as const,
		onPayload: (request: unknown) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	};
	if (providerModel.api === "google-generative-ai") {
		await streamGoogle(providerModel, context, options).result();
	} else {
		await streamVertex(providerModel, context, options).result();
	}
	if (!payload) throw new Error("Payload was not captured");
	return payload;
}

describe("Google thinking level maps", () => {
	it("resolves extended and uppercase mapped levels", () => {
		const google = model("google-generative-ai", { xhigh: "HIGH", max: "low" });
		expect(resolveGoogleThinkingLevel(google, "xhigh")).toBe("high");
		expect(resolveGoogleThinkingLevel(google, "max")).toBe("low");
	});

	it.each(["google-generative-ai", "google-vertex"] as const)("uses mapped levels for %s", async (api) => {
		const payload = await capturePayload(model(api, { high: "LOW" }));
		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingLevel: "LOW" } } });
	});
});
