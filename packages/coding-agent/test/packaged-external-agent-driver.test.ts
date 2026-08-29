import { describe, expect, it } from "vitest";
import {
	PackagedExternalAgentDriverAssetError,
	loadPackagedExternalAgentDriver,
	runPackagedExternalAgentDriverFixture,
} from "../src/core/packaged-external-agent-driver.ts";

describe("packaged External Agent driver fixture", () => {
	it("loads the immutable default-off fake Connector fixture", () => {
		const fixture = loadPackagedExternalAgentDriver("fake-connector");
		expect(fixture).toMatchObject({
			schemaVersion: 1,
			fixtureId: "aos.fake-connector",
			providerId: "aos.fake-connector",
			fakeProviderId: "aos.fake-provider",
			defaultEnabled: false,
			credentialMode: "none",
			networkMode: "disabled",
		});
		expect(fixture.operations.map(({ kind }) => kind)).toEqual(["start", "tool", "resume", "cancel"]);
		expect(Object.isFrozen(fixture)).toBe(true);
		expect(Object.isFrozen(fixture.operations)).toBe(true);
	});

	it("executes one deterministic fake-Connector lifecycle without enabling it by default", async () => {
		const fixture = loadPackagedExternalAgentDriver("fake-connector");
		const trace = await runPackagedExternalAgentDriverFixture();
		expect(trace.defaultEnabled).toBe(false);
		expect(trace.credentialMode).toBe("none");
		expect(trace.networkMode).toBe("disabled");
		expect(trace.events).not.toBe(fixture.operations);
		expect(trace.events.map(({ kind }) => kind)).toEqual([
			"capabilities",
			"start",
			"tool",
			"resume",
			"cancel",
		]);
		expect(trace.events.map(({ output }) => output)).toEqual([
			"external_connector.lifecycle:1,external_connector.tool_gateway:1",
			"attempt:starting",
			"tool:ok",
			"receipt:succeeded",
			"receipt:cancelled",
		]);
		expect(trace.receipts.map(({ phase, status }) => ({ phase, status }))).toEqual([
			{ phase: "run", status: "suspended" },
			{ phase: "resume", status: "succeeded" },
			{ phase: "cancel", status: "cancelled" },
		]);
		expect(trace.toolResult).toEqual({
			toolCallId: "aos.fake-tool-call",
			toolName: "fixture.echo",
			ok: true,
			sideEffectState: "none",
			output: "echo:deterministic",
		});
		expect(trace.lifecycle).toEqual({
			capabilities: 1,
			probeCapabilities: 1,
			createAttempt: 2,
			runAttempt: 1,
			tool: 1,
			resumeAttempt: 1,
			cancelAttempt: 1,
			reconcileAttempt: 1,
			dispose: 1,
		});
	});

	it("fails safely when the allowlisted packaged asset is unavailable", () => {
		expect(() => loadPackagedExternalAgentDriver("fake-missing-connector")).toThrow(
			PackagedExternalAgentDriverAssetError,
		);
		try {
			loadPackagedExternalAgentDriver("fake-missing-connector");
		} catch (error) {
			expect(error).toMatchObject({ code: "external_agent_driver_asset_missing" });
		}
	});
});
