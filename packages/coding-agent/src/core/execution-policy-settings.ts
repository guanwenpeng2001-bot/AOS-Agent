import { createHash } from "node:crypto";
import {
	LEGACY_PROFILE,
	POLICY_DEFAULT_PROFILE,
	PolicyError,
	freezePolicyProfile,
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
	type PolicyErrorCode,
	type PolicyProfileNarrowing,
} from "./execution-policy.ts";
import {
	preserveManagedProtectedPathRules,
	type ProtectedPathPolicy,
	type ProtectedPathRule,
} from "./protected-path-policy.ts";

/** The version of the JSON settings shape owned by the policy settings layer. */
export const EXECUTION_POLICY_SETTINGS_VERSION = 1 as const;

/** Built-in provider identifiers. Test-only providers must be explicitly registered. */
export const DEFAULT_REGISTERED_SANDBOX_PROVIDER_IDS = Object.freeze([
	"legacy-host",
	"host-policy",
] as const);

export type ExecutionPolicySettingsErrorCode = Extract<
	PolicyErrorCode,
	"policy_settings_invalid" | "policy_profile_not_found" | "policy_profile_untrusted"
>;

/** A settings error carries a safe config path and never includes raw values. */
export class ExecutionPolicySettingsError extends PolicyError {
	readonly path: string;

	constructor(code: ExecutionPolicySettingsErrorCode, message: string, path = "") {
		super(code, message);
		this.name = "ExecutionPolicySettingsError";
		this.path = path;
	}
}

/** Short alias used by settings-layer callers. */
export { ExecutionPolicySettingsError as PolicySettingsError };

/** Raw `executionPolicy` settings as they appear in a settings file. */
export interface ExecutionPolicySettingsConfig {
	defaultProfile?: unknown;
	profiles?: unknown;
}

/** A source may be either the nested policy object or a full Settings object. */
export type ExecutionPolicySettingsInput = unknown;

export type SandboxProviderRegistry =
	| ReadonlySet<string>
	| ReadonlyMap<string, unknown>
	| ReadonlyArray<string>
	| Readonly<Record<string, unknown>>;

export interface ExecutionPolicySettingsSelectionOptions {
	/** Run-level named profile selector. Inline policy objects are not accepted. */
	policyProfile?: unknown;
	/** Run options are accepted only to read the named `policyProfile` field. */
	run?: unknown;
	/** Runtime provider registry. If omitted, only built-in/test IDs are accepted. */
	registeredProviderIds?: SandboxProviderRegistry;
	/** Alias for integrations that expose a provider registry under this name. */
	registeredProviders?: SandboxProviderRegistry;
	/** Alias for integrations that expose sandbox providers explicitly. */
	registeredSandboxProviders?: SandboxProviderRegistry;
	/** Alias for integrations that expose provider IDs directly. */
	providerIds?: SandboxProviderRegistry;
	/** Alias for integrations that expose sandbox provider IDs directly. */
	sandboxProviderIds?: SandboxProviderRegistry;
}

export interface ExecutionPolicySettingsBuildOptions extends ExecutionPolicySettingsSelectionOptions {
	/** System policy defaults/catalog, if the host supplies one. */
	system?: ExecutionPolicySettingsInput;
	/** User/global settings or a nested `executionPolicy` object. */
	global?: ExecutionPolicySettingsInput;
	/** Project settings or a nested `executionPolicy` object. */
	project?: ExecutionPolicySettingsInput;
	/** The decision supplied by the existing ProjectTrust flow. */
	projectTrusted?: boolean;
	/** String form of the existing trust result for resolver-facing callers. */
	projectTrust?: "trusted" | "untrusted";
	/** Direct project selector aliases for resolver-facing integrations. */
	projectProfileId?: unknown;
	projectProfile?: unknown;
}

export type ExecutionPolicySettingsScope = "global" | "system" | "project";

export interface ExecutionPolicySettingsDiagnostic {
	readonly scope: ExecutionPolicySettingsScope;
	readonly trusted: boolean;
	readonly ignored: boolean;
	readonly code: "execution_policy_project_ignored";
	readonly reason: "project_untrusted";
	readonly message: string;
}

/** Effective, trust-aware policy settings consumed by the next lifecycle task. */
export interface ExecutionPolicySettings {
	readonly version: typeof EXECUTION_POLICY_SETTINGS_VERSION;
	/** Effective global/project default; a Run selector does not rewrite it. */
	readonly defaultProfile: string;
	readonly globalDefaultProfile: string;
	readonly projectDefaultProfile?: string;
	/** The profile selected for this call, including project narrowing. */
	readonly selectedProfileId: string;
	readonly selectedProfile: ExecutionPolicyProfile;
	/** Alias for consumers that call the selected profile simply `profile`. */
	readonly profile: ExecutionPolicyProfile;
	/** Effective profiles; project entries can only be stricter than their base. */
	readonly profiles: Readonly<Record<string, ExecutionPolicyProfile>>;
	readonly projectTrusted: boolean;
	readonly configRevision: string;
	readonly revision: string;
	readonly registeredProviderIds: ReadonlyArray<string>;
	readonly sandboxProviderIds: ReadonlyArray<string>;
	readonly diagnostics: ReadonlyArray<ExecutionPolicySettingsDiagnostic>;
}

interface ParsedPolicyConfig {
	readonly defaultProfile?: string;
	readonly profiles: Readonly<Record<string, unknown>>;
	readonly hadValue: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const POLICY_CONFIG_KEYS = new Set(["defaultProfile", "profiles"]);
const PROJECT_INJECTION_KEYS = new Set([
	"providerPackage",
	"providerPackages",
	"sandboxProviderPackage",
	"sandboxProviderPackages",
	"providerModule",
	"providerModulePath",
	"module",
	"modulePath",
	"package",
	"packageName",
	"packages",
	"token",
	"tokens",
	"credential",
	"credentialValue",
	"credentialValues",
	"environment",
	"environmentValues",
	"parentEnvironment",
	"env",
	"headers",
	"headerValues",
	"url",
	"urls",
	"command",
	"commands",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
	return Object.hasOwn(value, key);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stableValue(item));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
	return result;
}

function createRevision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function fail(code: ExecutionPolicySettingsErrorCode, path: string, message: string): never {
	throw new ExecutionPolicySettingsError(code, message, path);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function parseSelector(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (!isIdentifier(value)) {
		fail("policy_settings_invalid", path, "profile selector must be a registered identifier");
	}
	return value;
}

function unwrapPolicyConfig(value: unknown, path: string): unknown {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) fail("policy_settings_invalid", path, "executionPolicy must be an object");
	if (hasOwn(value, "executionPolicy")) return unwrapPolicyConfig(value.executionPolicy, `${path}.executionPolicy`);
	return value;
}

function parsePolicyConfig(value: unknown, path: string): ParsedPolicyConfig {
	const unwrapped = unwrapPolicyConfig(value, path);
	if (unwrapped === undefined) return { profiles: {}, hadValue: false };
	if (!isRecord(unwrapped)) fail("policy_settings_invalid", path, "executionPolicy must be an object");
	for (const key of Object.keys(unwrapped)) {
		if (!POLICY_CONFIG_KEYS.has(key)) {
			fail("policy_settings_invalid", `${path}.${key}`, "unknown execution policy settings field");
		}
	}
	const defaultProfile = parseSelector(unwrapped.defaultProfile, `${path}.defaultProfile`);
	const profiles: Record<string, unknown> = {};
	if (unwrapped.profiles !== undefined) {
		if (!isRecord(unwrapped.profiles)) fail("policy_settings_invalid", `${path}.profiles`, "profiles must be an object");
		for (const [id, profile] of Object.entries(unwrapped.profiles)) {
			if (!isIdentifier(id)) fail("policy_settings_invalid", `${path}.profiles.${id}`, "profile id is invalid");
			profiles[id] = profile;
		}
	}
	return {
		...(defaultProfile === undefined ? {} : { defaultProfile }),
		profiles,
		hadValue: Object.keys(unwrapped).length > 0,
	};
}

/** Parse a standalone policy object without applying trust or run selection. */
export function parseExecutionPolicySettingsConfig(value: unknown): ExecutionPolicySettingsConfig {
	const parsed = parsePolicyConfig(value, "$.executionPolicy");
	return deepFreeze({
		...(parsed.defaultProfile === undefined ? {} : { defaultProfile: parsed.defaultProfile }),
		...(Object.keys(parsed.profiles).length === 0 ? {} : { profiles: { ...parsed.profiles } }),
	});
}

export const validateExecutionPolicySettingsConfig = parseExecutionPolicySettingsConfig;
export const parseExecutionPolicySettings = parseExecutionPolicySettingsConfig;

function parseProfiles(
	profiles: Readonly<Record<string, unknown>>,
	path: string,
	allowManagedLocks: boolean,
): Readonly<Record<string, ExecutionPolicyProfile>> {
	const parsed: Record<string, ExecutionPolicyProfile> = {};
	for (const [id, value] of Object.entries(profiles)) {
		try {
			const profile = freezePolicyProfile(value as ExecutionPolicyProfile);
			if (profile.id !== id) {
				fail("policy_settings_invalid", `${path}.${id}.id`, "profile id must match its registered name");
			}
			if (!allowManagedLocks && (profile.protectedPaths?.managedLocks?.length ?? 0) > 0) {
				fail("policy_profile_untrusted", `${path}.${id}.protectedPaths.managedLocks`, "managed review locks can only come from system policy");
			}
			parsed[id] = profile;
		} catch (error) {
			if (error instanceof ExecutionPolicySettingsError) throw error;
			if (error instanceof PolicyError) {
				fail(error.code as ExecutionPolicySettingsErrorCode, `${path}.${id}`, "profile is invalid");
			}
			fail("policy_settings_invalid", `${path}.${id}`, "profile is invalid");
		}
	}
	return parsed;
}

function mergeCatalogs(
	system: ParsedPolicyConfig,
	global: ParsedPolicyConfig,
): { profiles: Readonly<Record<string, ExecutionPolicyProfile>>; defaultProfile: string } {
	const systemProfiles = parseProfiles(system.profiles, "$.system.executionPolicy.profiles", true);
	const globalProfiles = parseProfiles(global.profiles, "$.global.executionPolicy.profiles", false);
	const managedProtectedPaths = collectManagedProtectedPathRules(systemProfiles);
	const profiles: Record<string, ExecutionPolicyProfile> = { ...systemProfiles, ...globalProfiles };
	if (profiles[POLICY_DEFAULT_PROFILE] === undefined) profiles[POLICY_DEFAULT_PROFILE] = LEGACY_PROFILE;
	for (const [id, profile] of Object.entries(profiles)) {
		const path = Object.hasOwn(globalProfiles, id)
			? `$.global.executionPolicy.profiles.${id}`
			: Object.hasOwn(systemProfiles, id)
				? `$.system.executionPolicy.profiles.${id}`
				: `$.executionPolicy.profiles.${id}`;
		profiles[id] = applyManagedProtectedPathRules(profile, managedProtectedPaths, path);
	}
	const defaultProfile = global.defaultProfile ?? system.defaultProfile ?? POLICY_DEFAULT_PROFILE;
	if (profiles[defaultProfile] === undefined) {
		fail(
			"policy_profile_not_found",
			"$.executionPolicy.defaultProfile",
			`profile "${defaultProfile}" is not registered`,
		);
	}
	return { profiles: deepFreeze(profiles), defaultProfile };
}

function collectManagedProtectedPathRules(
	systemProfiles: Readonly<Record<string, ExecutionPolicyProfile>>,
): ProtectedPathPolicy | undefined {
	const rules = new Map<string, ProtectedPathRule>();
	for (const [profileId, profile] of Object.entries(systemProfiles)) {
		const protectedPaths = profile.protectedPaths;
		if (protectedPaths === undefined) continue;
		for (const managedId of protectedPaths.managedLocks ?? []) {
			const rule = protectedPaths.rules.find((candidate) => candidate.id === managedId);
			if (rule === undefined) {
				fail(
					"policy_settings_invalid",
					`$.system.executionPolicy.profiles.${profileId}.protectedPaths.managedLocks`,
					"system managed review lock must reference a registered rule",
				);
			}
			const previous = rules.get(managedId);
			if (previous !== undefined && JSON.stringify(stableValue(previous)) !== JSON.stringify(stableValue(rule))) {
				fail(
					"policy_settings_invalid",
					`$.system.executionPolicy.profiles.${profileId}.protectedPaths.managedLocks`,
					"system managed review lock ids must describe one rule",
				);
			}
			rules.set(managedId, rule);
		}
	}
	if (rules.size === 0) return undefined;
	return preserveManagedProtectedPathRules(
		{
			rules: [...rules.values()].sort((left, right) => left.id.localeCompare(right.id)),
			managedLocks: [...rules.keys()].sort(),
		},
		undefined,
	);
}

function applyManagedProtectedPathRules(
	profile: ExecutionPolicyProfile,
	managedProtectedPaths: ProtectedPathPolicy | undefined,
	path: string,
): ExecutionPolicyProfile {
	if (managedProtectedPaths === undefined) return profile;
	const protectedPaths = preserveManagedProtectedPathRules(managedProtectedPaths, profile.protectedPaths);
	if (protectedPaths === undefined) {
		fail("policy_profile_untrusted", `${path}.protectedPaths`, "user policy cannot widen a managed review lock");
	}
	return freezePolicyProfile({ ...profile, protectedPaths });
}

function normalizeProviderIds(value: SandboxProviderRegistry | undefined, path: string): string[] {
	if (value === undefined) return [...DEFAULT_REGISTERED_SANDBOX_PROVIDER_IDS];
	const ids = value instanceof Set || value instanceof Map ? [...value.keys()] : Array.isArray(value) ? [...value] : Object.keys(value);
	if (!ids.every((id): id is string => isIdentifier(id))) {
		fail("policy_settings_invalid", path, "registered provider ids must be safe identifiers");
	}
	return [...new Set(ids)].sort();
}

function getRegisteredProviderIds(options: ExecutionPolicySettingsBuildOptions): string[] {
	const configured =
		options.registeredProviderIds ??
		options.registeredProviders ??
		options.registeredSandboxProviders ??
		options.providerIds ??
		options.sandboxProviderIds;
	return normalizeProviderIds(configured, "$.registeredProviderIds");
}

function validateRegisteredProviders(
	profiles: Readonly<Record<string, ExecutionPolicyProfile>>,
	providerIds: ReadonlySet<string>,
	path: string,
): void {
	for (const [id, profile] of Object.entries(profiles)) {
		if (profile.enforcement !== "sandbox" || profile.sandboxProvider === undefined) continue;
		if (!providerIds.has(profile.sandboxProvider)) {
			fail(
				"policy_settings_invalid",
				`${path}.${id}.sandboxProvider`,
				"sandbox provider is not registered",
			);
		}
	}
}

function looksLikeUrl(value: string): boolean {
	return URL_SCHEME_PATTERN.test(value) || value.startsWith("//");
}

/**
 * Project settings are hostile input even after the existing trust decision:
 * they may narrow a user profile, but cannot become a provider/package/env or
 * URL injection channel. This walk only reports safe policy errors and does
 * not retain any project value in diagnostics.
 */
function validateProjectInjectionSurface(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			validateProjectInjectionSurface(value[index], `${path}[${index}]`);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (PROJECT_INJECTION_KEYS.has(key)) {
			fail("policy_profile_untrusted", `${path}.${key}`, "project policy cannot inject providers, packages, credentials, environment, or URLs");
		}
		if (key === "inheritEnvironment" && child === true) {
			fail("policy_profile_untrusted", `${path}.${key}`, "project policy cannot inherit the parent environment");
		}
		if (key === "allowDestinations" && Array.isArray(child)) {
			for (let index = 0; index < child.length; index++) {
				if (typeof child[index] === "string" && looksLikeUrl(child[index])) {
					fail("policy_profile_untrusted", `${path}.${key}[${index}]`, "project policy cannot inject arbitrary URLs");
				}
			}
		}
		validateProjectInjectionSurface(child, `${path}.${key}`);
	}
}

function projectConfigFromDirectOptions(options: ExecutionPolicySettingsBuildOptions): unknown {
	if (options.projectProfileId === undefined && options.projectProfile === undefined) return options.project;
	if (options.project !== undefined) {
		fail("policy_settings_invalid", "$.project", "project selector must be declared in one place");
	}
	const profileId = parseSelector(options.projectProfileId, "$.projectProfileId");
	if (options.projectProfile !== undefined && profileId === undefined) {
		fail("policy_settings_invalid", "$.projectProfileId", "projectProfileId is required with projectProfile");
	}
	return {
		...(profileId === undefined ? {} : { defaultProfile: profileId }),
		...(options.projectProfile === undefined || profileId === undefined
				? {}
				: {
					profiles: {
						[profileId]: options.projectProfile,
					},
				}),
	};
}

function parseRunSelector(options: ExecutionPolicySettingsBuildOptions): string | undefined {
	const direct = parseSelector(options.policyProfile, "$.policyProfile");
	if (options.run === undefined) return direct;
	if (!isRecord(options.run)) fail("policy_settings_invalid", "$.run", "run options must be an object");
	for (const key of Object.keys(options.run)) {
		if (key !== "policyProfile") fail("policy_settings_invalid", `$.run.${key}`, "unknown run policy field");
	}
	const runSelector = parseSelector(options.run.policyProfile, "$.run.policyProfile");
	if (direct !== undefined && runSelector !== undefined && direct !== runSelector) {
		fail("policy_settings_invalid", "$.policyProfile", "conflicting run profile selectors");
	}
	return direct ?? runSelector;
}

function mapPolicyError(error: PolicyError, path: string): never {
	const code: ExecutionPolicySettingsErrorCode =
		error.code === "policy_profile_not_found" || error.code === "policy_profile_untrusted"
			? error.code
			: "policy_settings_invalid";
	throw new ExecutionPolicySettingsError(code, error.message, path);
}

function mergeProjectProfile(
	baseProfile: ExecutionPolicyProfile,
	rawNarrowing: unknown,
	projectTrusted: boolean,
	path: string,
): ExecutionPolicyProfile {
	try {
		const result = resolveExecutionPolicyProfile({
			profiles: { [baseProfile.id]: baseProfile },
			defaultProfile: baseProfile.id,
			projectTrusted,
			projectProfile: rawNarrowing,
		});
		if (result.ok === false) return mapPolicyError(result.error, path);
		return result.profile;
	} catch (error) {
		if (error instanceof ExecutionPolicySettingsError) throw error;
		if (error instanceof PolicyError) mapPolicyError(error, path);
		fail("policy_settings_invalid", path, "project profile narrowing is invalid");
	}
}

function parseProjectProfiles(
	project: ParsedPolicyConfig,
	baseProfiles: Readonly<Record<string, ExecutionPolicyProfile>>,
	projectTrusted: boolean,
): Readonly<Record<string, ExecutionPolicyProfile>> {
	const profiles: Record<string, ExecutionPolicyProfile> = { ...baseProfiles };
	for (const [id, rawNarrowing] of Object.entries(project.profiles)) {
		const baseProfile = baseProfiles[id];
		if (baseProfile === undefined) {
			fail(
				projectTrusted ? "policy_profile_not_found" : "policy_profile_untrusted",
				`$.project.executionPolicy.profiles.${id}`,
				"project policy must reference a registered user profile",
			);
		}
		validateProjectInjectionSurface(rawNarrowing, `$.project.executionPolicy.profiles.${id}`);
		profiles[id] = mergeProjectProfile(baseProfile, rawNarrowing, projectTrusted, `$.project.executionPolicy.profiles.${id}`);
	}
	return deepFreeze(profiles);
}

function projectRevisionIsSafe(
	profiles: Readonly<Record<string, ExecutionPolicyProfile>>,
	project: ParsedPolicyConfig,
): void {
	for (const [id, raw] of Object.entries(project.profiles)) {
		if (!isRecord(raw) || raw.revision === undefined) continue;
		const baseRevision = profiles[id]?.revision;
		if (baseRevision === undefined || raw.revision !== baseRevision) {
			fail("policy_profile_untrusted", `$.project.executionPolicy.profiles.${id}.revision`, "project cannot replace a registered profile revision");
		}
	}
}

function createIgnoredDiagnostic(): ExecutionPolicySettingsDiagnostic {
	return {
		scope: "project",
		trusted: false,
		ignored: false,
		code: "execution_policy_project_ignored",
		reason: "project_untrusted",
		message: "Project execution policy was constrained because the project is untrusted.",
	};
}

/**
 * Parse system/global/project policy settings, apply the existing trust result,
 * and select a named Run profile. No profile or provider is accepted from an
 * inline Run payload, and all returned profiles are deeply immutable.
 */
export function buildExecutionPolicySettings(options: ExecutionPolicySettingsBuildOptions = {}): ExecutionPolicySettings {
	const system = parsePolicyConfig(options.system, "$.system.executionPolicy");
	const global = parsePolicyConfig(options.global, "$.global.executionPolicy");
	const projectInput = projectConfigFromDirectOptions(options);
	if (projectInput !== undefined) validateProjectInjectionSurface(unwrapPolicyConfig(projectInput, "$.project.executionPolicy"), "$.project.executionPolicy");
	const project = parsePolicyConfig(projectInput, "$.project.executionPolicy");
	const projectTrusted = options.projectTrusted ?? (options.projectTrust === undefined || options.projectTrust === "trusted");
	const providerIds = getRegisteredProviderIds(options);
	const providerIdSet = new Set(providerIds);
	const catalog = mergeCatalogs(system, global);
	validateRegisteredProviders(catalog.profiles, providerIdSet, "$.executionPolicy.profiles");
	const globalDefaultProfile = catalog.defaultProfile;

	if (!projectTrusted && project.defaultProfile !== undefined && project.defaultProfile !== globalDefaultProfile) {
		fail("policy_profile_untrusted", "$.project.executionPolicy.defaultProfile", "untrusted project cannot select a different profile");
	}
	if (project.defaultProfile !== undefined && catalog.profiles[project.defaultProfile] === undefined) {
		fail(
			projectTrusted ? "policy_profile_not_found" : "policy_profile_untrusted",
			"$.project.executionPolicy.defaultProfile",
			"project policy must select a registered profile",
		);
	}

	const effectiveProfiles = parseProjectProfiles(project, catalog.profiles, projectTrusted);
	projectRevisionIsSafe(catalog.profiles, project);
	const projectDefaultProfile = project.defaultProfile;
	const defaultProfile = projectTrusted && projectDefaultProfile !== undefined ? projectDefaultProfile : globalDefaultProfile;
	const runProfile = parseRunSelector(options);
	const selectedProfileId = runProfile ?? defaultProfile;
	if (effectiveProfiles[selectedProfileId] === undefined) {
		fail("policy_profile_not_found", "$.policyProfile", "Run profile must name a registered profile");
	}
	const selectedProfile = effectiveProfiles[selectedProfileId];
	const configRevision = createRevision({
		version: EXECUTION_POLICY_SETTINGS_VERSION,
		globalDefaultProfile,
		defaultProfile,
		profiles: effectiveProfiles,
		projectTrusted,
	});
	const diagnostics = !projectTrusted && project.hadValue ? [createIgnoredDiagnostic()] : [];
	return deepFreeze({
		version: EXECUTION_POLICY_SETTINGS_VERSION,
		defaultProfile,
		globalDefaultProfile,
		...(projectDefaultProfile === undefined ? {} : { projectDefaultProfile }),
		selectedProfileId,
		selectedProfile,
		profile: selectedProfile,
		profiles: effectiveProfiles,
		projectTrusted,
		configRevision,
		revision: configRevision,
		registeredProviderIds: providerIds,
		sandboxProviderIds: providerIds,
		diagnostics,
	});
}

export const resolveExecutionPolicySettings = buildExecutionPolicySettings;

/** Return an immutable copy suitable for public diagnostics or a policy binding. */
export function createExecutionPolicySettingsView(settings: ExecutionPolicySettings): ExecutionPolicySettings {
	return deepFreeze({
		...settings,
		profiles: Object.fromEntries(
			Object.entries(settings.profiles).map(([id, profile]) => [id, freezePolicyProfile(profile)]),
		),
		selectedProfile: freezePolicyProfile(settings.selectedProfile),
		profile: freezePolicyProfile(settings.profile),
		registeredProviderIds: [...settings.registeredProviderIds],
		sandboxProviderIds: [...settings.sandboxProviderIds],
		diagnostics: settings.diagnostics.map((diagnostic) => ({ ...diagnostic })),
	});
}

/** Safe helper for SettingsManager callers that need the selected profile only. */
export function getExecutionPolicyProfile(settings: ExecutionPolicySettings): ExecutionPolicyProfile {
	return settings.selectedProfile;
}

/** Keep the narrowing type discoverable to policy consumers without re-declaring it. */
export type ExecutionPolicyProjectNarrowing = PolicyProfileNarrowing;
