import { describe, expect, it } from "vitest";
import {
	classifyFallbackEligibility,
	ModelBroker,
	parseModelReference,
	preflightBudget,
	resolveModel,
	settleBudget,
	type ModelReference,
} from "../src/core/model-broker.ts";

describe("model-broker", () => {
	it("normalizes safe references and rejects credential-bearing references", () => {
		const parsed = parseModelReference({ provider: "openai", id: "gpt-5", api: "openai-responses" });
		expect(parsed).toEqual({
			ok: true,
			reference: { provider: "openai", id: "gpt-5", api: "openai-responses" },
		});
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parseModelReference("openai/gpt-5")).toEqual({ ok: true, reference: { provider: "openai", id: "gpt-5" } });

		const unsafe = parseModelReference({ provider: "openai", id: "gpt-5", apiKey: "sk-private" });
		expect(unsafe.ok).toBe(false);
		if (!unsafe.ok) expect(unsafe.error.code).toBe("model_invalid_reference");
	});

	it("uses manual, direct, route, then role precedence and freezes bindings", () => {
		let bindingNumber = 0;
		const broker = new ModelBroker({
			routes: { stable: [{ provider: "route-provider", id: "route-model" }] },
			roles: { coder: [{ provider: "role-provider", id: "role-model" }] },
			now: () => "2026-08-12T00:00:00.000Z",
			bindingIdFactory: () => `model-binding:test-${++bindingNumber}`,
		});
		const manual: ModelReference = { provider: "manual-provider", id: "manual-model" };
		const result = broker.resolve({
			manual,
			direct: { provider: "direct-provider", id: "direct-model" },
			route: "stable",
			role: "coder",
		});
		expect(result.source).toBe("manual");
		expect(result.reference).toEqual({ provider: "manual-provider", id: "manual-model" });
		expect(result.bindingId).toBe("model-binding:test-1");
		expect(result.fallbackAllowed).toBe(false);
		expect(Object.isFrozen(result.binding)).toBe(true);

		manual.id = "mutated-after-resolution";
		expect(result.reference.id).toBe("manual-model");
		expect(broker.getBinding(result.bindingId)).toBe(result.binding);

		expect(broker.resolve({ direct: { provider: "direct-provider", id: "direct-model" } }).source).toBe("direct");
		expect(broker.resolve({ route: "stable" }).fallbackAllowed).toBe(true);
		expect(broker.resolve({ role: "coder" }).fallbackAllowed).toBe(true);
	});

	it("selects the first available route candidate without falling through an explicit route", () => {
		const routeResult = resolveModel(
			{ route: [
				{ provider: "offline", id: "first", available: false },
				{ provider: "healthy", id: "second", priority: 1 },
			] },
			{ bindingIdFactory: () => "model-binding:inline" },
		);
		expect(routeResult.ok).toBe(true);
		if (routeResult.ok) {
			expect(routeResult.resolution.reference).toEqual({ provider: "healthy", id: "second" });
			expect(routeResult.resolution.source).toBe("route");
		}

		const unavailable = resolveModel(
			{ route: [{ provider: "offline", id: "first", available: false }], role: "missing" },
			{ roles: { missing: [] } },
		);
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) expect(unavailable.error.code).toBe("model_route_unavailable");
	});

	it("permits fallback only for transient failures before visible side effects", () => {
		expect(classifyFallbackEligibility({ category: "timeout" })).toMatchObject({ eligible: true });
		expect(classifyFallbackEligibility({ category: "auth" })).toMatchObject({ eligible: false });
		expect(
		classifyFallbackEligibility({ category: "rate_limit" }, ["partial_output"]),
		).toMatchObject({ eligible: false });
		expect(classifyFallbackEligibility({ category: "timeout" }, { visibleOutput: true })).toMatchObject({ eligible: false });
	});

	it("reserves budget during preflight and settles only actual usage", () => {
		const broker = new ModelBroker({
			budget: { maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 120, maxCost: 1 },
			bindingIdFactory: () => "model-binding:budget",
		});
		const first = broker.preflightBudget({ estimate: { input: 40, output: 20, total: 60, cost: 0.4 } });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.preflight.remaining).toEqual({ inputTokens: 60, outputTokens: 30, totalTokens: 60, cost: 0.6 });

		const blocked = broker.preflightBudget({ estimate: { input: 70, output: 0, total: 70, cost: 0.1 } });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("model_budget_exceeded");

		const settled = broker.settleBudget(first.preflight.reservation.id, { input: 20, output: 10, total: 30, cost: 0.2 });
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		expect(settled.settlement.state.committed).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30, cost: 0.2 });
		expect(settled.settlement.state.reserved).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
		expect(broker.settleBudget(first.preflight.reservation.id, {}).ok).toBe(false);
	});

	it("supports pure budget preflight/settlement and redacted public summaries", () => {
		const preflight = preflightBudget(
			{ maxTotalTokens: 100, maxCost: 2 },
			{ input: 10, output: 10, total: 20, cost: 0.5 },
		);
		expect(preflight.ok).toBe(true);
		if (!preflight.ok) return;
		const settlement = settleBudget(preflight.preflight, { input: 5, output: 5, total: 10, cost: 0.25 });
		expect(settlement.ok).toBe(true);
		if (!settlement.ok) return;
		expect(settlement.settlement.remaining.totalTokens).toBe(90);

		const broker = new ModelBroker({ routes: { stable: [{ provider: "openai", id: "gpt-5" }] } });
		broker.resolve({ route: "stable" });
		const serialized = JSON.stringify(broker.publicSummary());
		expect(serialized).toContain("openai");
		expect(serialized).not.toContain("apiKey");
		expect(serialized).not.toContain("authorization");
		expect(serialized).not.toContain("token");
	});
});
