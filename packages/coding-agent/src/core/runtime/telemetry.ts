import {
	NOOP_TELEMETRY_CONTEXT,
	OtlpHttpTelemetryContext,
	type OtlpHttpTelemetryDiagnostic,
	type TelemetryContext,
} from "@aos-agent/agent-core";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.AOS_AGENT_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

export interface ProductTelemetry {
	readonly context: TelemetryContext;
	shutdown(): Promise<void>;
}

export interface ProductTelemetryOptions {
	readonly offlineEnv?: string;
	readonly request?: typeof fetch;
	readonly onDiagnostic?: (diagnostic: OtlpHttpTelemetryDiagnostic) => void;
}

const DISABLED_PRODUCT_TELEMETRY: ProductTelemetry = Object.freeze({
	context: NOOP_TELEMETRY_CONTEXT,
	shutdown: () => Promise.resolve(),
});

/** Build the session-owned product telemetry context. Invalid config disables export. */
export function createProductTelemetry(
	settingsManager: SettingsManager,
	options: ProductTelemetryOptions = {},
): ProductTelemetry {
	if (isTruthyEnvFlag(options.offlineEnv ?? process.env.AOS_AGENT_OFFLINE)) return DISABLED_PRODUCT_TELEMETRY;
	try {
		const settings = settingsManager.getTelemetrySettings();
		if (!settings.enabled) return DISABLED_PRODUCT_TELEMETRY;
		const exporter = new OtlpHttpTelemetryContext({
			endpoint: settings.endpoint,
			sampleRate: settings.sampleRate,
			...(options.request === undefined ? {} : { request: options.request }),
			...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
		});
		return { context: exporter, shutdown: () => exporter.shutdown() };
	} catch {
		return DISABLED_PRODUCT_TELEMETRY;
	}
}
