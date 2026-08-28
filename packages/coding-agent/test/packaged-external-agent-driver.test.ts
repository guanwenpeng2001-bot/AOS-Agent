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
			fixtureId: "line13-fake-connector",
			providerId: "line13.fake-connector",
			fauxProviderId: "line13.faux-provider",
			defaultEnabled: false,
			credentialMode: "none",
			networkMode: "disabled",
		});
		expect(fixture.operations.map(({ kind }) => kind)).toEqual(["start", "tool", "resume", "cancel"]);
		expect(Object.isFrozen(fixture)).toBe(true);
		expect(Object.isFrozen(fixture.operations)).toBe(true);
	});

	it("runs one deterministic fake-Connector trace without enabling a provider", () => {
		const trace = runPackagedExternalAgentDriverFixture();
		expect(trace.defaultEnabled).toBe(false);
		expect(trace.credentialMode).toBe("none");
		expect(trace.networkMode).toBe("disabled");
		expect(trace.events.map(({ output }) => output)).toEqual([
			"attempt:started",
			"tool:ok",
			"attempt:completed",
			"attempt:cancelled",
		]);
	});

	it("fails safely when the allowlisted packaged asset is unavailable", () => {
		expect(() => loadPackagedExternalAgentDriver("line13-missing-connector")).toThrow(
			PackagedExternalAgentDriverAssetError,
		);
		try {
			loadPackagedExternalAgentDriver("line13-missing-connector");
		} catch (error) {
			expect(error).toMatchObject({ code: "external_agent_driver_asset_missing" });
		}
	});
});
