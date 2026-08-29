import { validateEventPayloadForCategory } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.ts";
import type { ExternalAgentConnector } from "../../src/index.ts";
import { SUBAGENT_PROVIDER_KINDS } from "../../src/core/subagent/lifecycle.ts";

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

	it("rejects external protocol placeholders from the Native lifecycle event schema", () => {
		const payload = {
			schemaVersion: 1,
			childAgentInstanceId: "child-1",
			parentAgentInstanceId: "parent-1",
			ancestorIds: ["root-1", "parent-1"],
			depth: 2,
			spawnId: "spawn-1",
			taskId: "task-1",
			dispatchId: "dispatch-1",
			attemptId: "attempt-1",
			bindingId: "binding-1",
			bindingEpochIds: ["epoch-1"],
			providerKind: "in_process",
			providerId: "child-provider",
			forkScope: "none",
			status: "running",
			revision: 1,
			createdAt: "2026-08-27T00:00:00.000Z",
		};
		expect(validateEventPayloadForCategory("subagent.lifecycle_transitioned", payload)).toBe(true);
		for (const providerKind of ["acp", "sdk", "connector.vendor"]) {
			expect(
				validateEventPayloadForCategory("subagent.lifecycle_transitioned", { ...payload, providerKind }),
			).toBe(false);
		}
	});
});
