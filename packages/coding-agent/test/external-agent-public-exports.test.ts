import { describe, expect, it } from "vitest";
import * as packageEntry from "../src/index.ts";
import {
	EXTERNAL_AGENT_ERROR_CODES,
	ExternalAgentError,
	createExternalAgentAdapterRegistry,
	isExternalAgentCapabilitySnapshot,
	isExternalAgentReceipt,
	isExternalAgentSelection,
	type ExternalAgentAdapter,
	type ExternalAgentAdapterRegistry,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentPreparedBinding,
	type ExternalAgentReceipt,
	type ExternalAgentSelection,
} from "../src/index.ts";

describe("External Agent Adapter public entry exports", () => {
	it("exposes only the intended safe contract through the package entry", () => {
		expect(typeof isExternalAgentSelection).toBe("function");
		expect(typeof isExternalAgentCapabilitySnapshot).toBe("function");
		expect(typeof isExternalAgentReceipt).toBe("function");
		expect(typeof createExternalAgentAdapterRegistry).toBe("function");
		expect(typeof ExternalAgentError).toBe("function");
		expect(EXTERNAL_AGENT_ERROR_CODES).toContain("external_agent_side_effect_unknown");
		expect("ExternalAgentTargetConnection" in packageEntry).toBe(false);
		expect("ExternalAgentEndpoint" in packageEntry).toBe(false);
		expect("loadExternalAgentAdapter" in packageEntry).toBe(false);
	});

	it("keeps the public types type-safe for Host wiring", () => {
		const registry: ExternalAgentAdapterRegistry = createExternalAgentAdapterRegistry();
		const adapter: ExternalAgentAdapter = {
			id: "entry-adapter",
			probe: async (): Promise<ExternalAgentCapabilitySnapshot> => {
				throw new ExternalAgentError("external_agent_probe_failed");
			},
			prepare: async (): Promise<ExternalAgentPreparedBinding> => {
				throw new ExternalAgentError("external_agent_binding_unsupported");
			},
			start: async (): Promise<never> => {
				throw new ExternalAgentError("external_agent_start_failed");
			},
		};
		registry.register(adapter, { targets: ["target-a"] });
		expect(registry.list()).toEqual([{ adapterId: "entry-adapter", displayName: "entry-adapter", version: "1" }]);
		const selection: ExternalAgentSelection = { adapterId: "entry-adapter", targetId: "target-a" };
		expect(isExternalAgentSelection(selection)).toBe(true);
		const receipt: ExternalAgentReceipt = {
			schemaVersion: 1,
			external: { namespace: "entry-adapter", externalSessionId: "session-target-a", externalRunId: "run-1" },
			status: "completed",
			endedAt: "2026-08-16T00:00:00.000Z",
			artifactRefs: [],
			sideEffects: "none",
		};
		expect(isExternalAgentReceipt(receipt)).toBe(true);
	});
});
