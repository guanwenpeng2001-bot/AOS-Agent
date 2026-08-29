import {
	buildExternalConnectorTargetConfig,
	type ExternalConnectorCapabilityNarrowing,
	type ExternalConnectorTargetCatalogConfig,
	type ExternalConnectorTargetConfig,
	type ExternalConnectorTargetSelectionConfig,
} from "./external-connector-target-config.ts";

/** User-local catalog plus an explicit default target selection. */
export interface ExternalConnectorGlobalSettings {
	readonly schemaVersion: 1;
	readonly targets: ExternalConnectorTargetCatalogConfig["targets"];
	readonly targetId?: string;
}

/** Trusted project narrowing, with an optional trusted Role narrowing. */
export interface ExternalConnectorProjectSettings {
	readonly schemaVersion: 1;
	readonly targetId?: string;
	readonly capabilityCeiling?: ExternalConnectorCapabilityNarrowing;
	readonly role?: ExternalConnectorTargetSelectionConfig;
}

export type ExternalConnectorSettingsConfig = ExternalConnectorGlobalSettings | ExternalConnectorProjectSettings;

export interface ExternalConnectorSettingsBuildOptions {
	readonly global?: unknown;
	readonly project?: unknown;
	readonly projectTrusted?: boolean;
}

const GLOBAL_KEYS = new Set(["schemaVersion", "targets", "targetId"]);
const PROJECT_KEYS = new Set(["schemaVersion", "targetId", "capabilityCeiling", "role"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
	return value;
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !keys.has(key)) {
			throw new TypeError(`${path} contains an unknown field`);
		}
	}
}

function parseGlobalSettings(value: unknown):
	| {
			readonly catalog: ExternalConnectorTargetCatalogConfig;
			readonly targetId?: unknown;
	  }
	| undefined {
	if (value === undefined) return undefined;
	const settings = assertObject(value, "$.global.externalConnectors");
	assertKnownKeys(settings, GLOBAL_KEYS, "$.global.externalConnectors");
	if (settings.schemaVersion !== 1) throw new TypeError("$.global.externalConnectors.schemaVersion must be 1");
	return {
		catalog: {
			schemaVersion: settings.schemaVersion as 1,
			targets: settings.targets as ExternalConnectorTargetCatalogConfig["targets"],
		},
		...(settings.targetId === undefined ? {} : { targetId: settings.targetId }),
	};
}

function parseProjectSettings(value: unknown):
	| {
			readonly selection?: unknown;
			readonly role?: unknown;
	  }
	| undefined {
	if (value === undefined) return undefined;
	const settings = assertObject(value, "$.project.externalConnectors");
	assertKnownKeys(settings, PROJECT_KEYS, "$.project.externalConnectors");
	if (settings.schemaVersion !== 1) throw new TypeError("$.project.externalConnectors.schemaVersion must be 1");
	const selection =
		settings.targetId === undefined && settings.capabilityCeiling === undefined
			? undefined
			: {
					schemaVersion: settings.schemaVersion,
					...(settings.targetId === undefined ? {} : { targetId: settings.targetId }),
					...(settings.capabilityCeiling === undefined ? {} : { capabilityCeiling: settings.capabilityCeiling }),
				};
	return {
		...(selection === undefined ? {} : { selection }),
		...(settings.role === undefined ? {} : { role: settings.role }),
	};
}

/**
 * Resolve settings through the existing branded target builder. Project and
 * Role values are passed with the same project-trust result and therefore fail
 * closed through the existing `untrusted_source` checks.
 */
export function buildExternalConnectorTargetSettings(
	options: ExternalConnectorSettingsBuildOptions = {},
): ExternalConnectorTargetConfig | undefined {
	if (options.global === undefined && options.project === undefined) return undefined;
	const global = parseGlobalSettings(options.global);
	const project = parseProjectSettings(options.project);
	const projectTrusted = options.projectTrusted ?? true;
	return buildExternalConnectorTargetConfig({
		...(global === undefined ? {} : { global: global.catalog }),
		...(global?.targetId === undefined ? {} : { explicitTargetId: global.targetId }),
		...(project?.selection === undefined ? {} : { project: project.selection, projectTrusted }),
		...(project?.role === undefined ? {} : { role: project.role, roleTrusted: projectTrusted }),
	});
}
