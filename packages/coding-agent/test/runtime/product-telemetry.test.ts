import { NOOP_TELEMETRY_CONTEXT } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { createProductTelemetry } from "../../src/core/runtime/telemetry.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";

describe("product telemetry", () => {
	it("is disabled by default and performs zero network calls", async () => {
		let calls = 0;
		const request: typeof fetch = async () => {
			calls++;
			return new Response("{}", { status: 200 });
		};
		const telemetry = createProductTelemetry(SettingsManager.inMemory(), { request, offlineEnv: "0" });

		expect(telemetry.context).toBe(NOOP_TELEMETRY_CONTEXT);
		await telemetry.context.startSpan({ name: "disabled" }, () => undefined);
		await telemetry.shutdown();
		expect(calls).toBe(0);
	});

	it("uses the telemetry settings only when explicitly enabled", async () => {
		let calls = 0;
		const request: typeof fetch = async () => {
			calls++;
			return new Response("{}", { status: 200 });
		};
		const settings = SettingsManager.inMemory({
			telemetry: { enabled: true, endpoint: "http://collector.test", sampleRate: 1 },
		});
		const telemetry = createProductTelemetry(settings, { request, offlineEnv: "0" });

		await telemetry.context.startSpan({ name: "enabled" }, () => undefined);
		await telemetry.shutdown();
		expect(calls).toBe(1);
	});

	it("disables export for invalid settings and offline mode", async () => {
		const invalid = SettingsManager.inMemory({ telemetry: { enabled: true, sampleRate: 2 } });
		expect(createProductTelemetry(invalid, { offlineEnv: "0" }).context).toBe(NOOP_TELEMETRY_CONTEXT);

		const enabled = SettingsManager.inMemory({ telemetry: { enabled: true } });
		expect(createProductTelemetry(enabled, { offlineEnv: "1" }).context).toBe(NOOP_TELEMETRY_CONTEXT);
	});
});
