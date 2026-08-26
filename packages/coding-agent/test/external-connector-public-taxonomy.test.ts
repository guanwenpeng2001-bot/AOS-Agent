import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";
import type { ExternalAgentConnector } from "../src/index.ts";
import { SUBAGENT_PROVIDER_KINDS } from "../src/core/subagent.ts";

function acceptsExternalConnector(connector: ExternalAgentConnector): ExternalAgentConnector {
	return connector;
}

describe("External Connector public taxonomy", () => {
	it("exports one open connector contract and registry factory without vendor drivers", () => {
		expect(publicApi.EXTERNAL_CONNECTOR_PROVIDER_CLASSES).toEqual(["external_connector"]);
		expect(typeof publicApi.createExternalConnectorRegistry).toBe("function");
		expect(publicApi.createExternalConnectorRegistry().list()).toEqual([]);
		expect(typeof acceptsExternalConnector).toBe("function");
		for (const vendorDriver of ["AcpConnector", "ClaudeConnector", "CodexConnector", "SdkConnector"]) {
			expect(vendorDriver in publicApi).toBe(false);
		}
	});

	it("keeps external protocol placeholders out of current Native Agent kinds", () => {
		expect(SUBAGENT_PROVIDER_KINDS).toEqual(["in_process", "fork", "agent_runtime_host"]);
		expect(SUBAGENT_PROVIDER_KINDS).not.toContain("acp");
		expect(SUBAGENT_PROVIDER_KINDS).not.toContain("sdk");
	});
});
