import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

describe("External Connector public exports", () => {
	it("exports only the current connector contract and safe product gates", () => {
		expect(typeof publicApi.createExternalConnectorRegistry).toBe("function");
		expect(typeof publicApi.createDurableExternalAgentConnector).toBe("function");
		expect(typeof publicApi.executeExternalConnectorProductRun).toBe("function");
		expect(typeof publicApi.gateCanonicalExternalAgentInputBeforeAcceptance).toBe("function");
		expect(typeof publicApi.projectExternalModelForExecution).toBe("function");
	});

	it("does not export the legacy Adapter peer contract", () => {
		for (const name of [
			"ExternalAgentAdapter",
			"ExternalAgentError",
			"createExternalAgentAdapterRegistry",
			"createExternalAgentPreparedBinding",
			"runExternalAgentAdapter",
		]) {
			expect(name in publicApi).toBe(false);
		}
	});
});
