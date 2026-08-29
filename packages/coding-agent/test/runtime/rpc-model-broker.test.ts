import { describe, expect, it } from "vitest";
import { ModelBroker } from "../../src/core/runtime/model-broker.ts";
import type { GetModelRoutesData } from "../../src/modes/rpc/rpc-types.ts";

describe("RPC ModelBroker public contract", () => {
	it("builds a get_model_routes payload with only public model metadata", () => {
		const broker = new ModelBroker({
			models: [{ provider: "fake", id: "fake-1" }],
			routes: {
				balanced: {
					candidates: [{ provider: "fake", id: "fake-1", label: "local" }],
					fallback: { maxAttempts: 1, on: [] },
				},
			},
			roles: { worker: "balanced" },
			bindingIdFactory: () => "model-binding:test",
		});
		const resolution = broker.resolveResult({ modelRoute: "balanced" });
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;

		const payload: GetModelRoutesData = broker.publicSummary(resolution.resolution.bindingId);

		expect(payload).toMatchObject({
			schemaVersion: 1,
			models: [{ provider: "fake", id: "fake-1" }],
			roles: ["worker"],
			currentBindingId: "model-binding:test",
		});
		expect(payload.routes[0]?.candidates[0]?.reference).toEqual({ provider: "fake", id: "fake-1" });
		expect(JSON.stringify(payload)).not.toMatch(/apiKey|headers|baseUrl|token|authorization/u);
	});

	it("returns a stable selection error for an unknown route", () => {
		const broker = new ModelBroker({ routes: { balanced: [{ provider: "fake", id: "fake-1" }] } });

		const result = broker.resolveResult({ modelRoute: "missing" });

		expect(result).toMatchObject({
			ok: false,
			error: { code: "model_route_not_found", retryable: false },
		});
	});
});
