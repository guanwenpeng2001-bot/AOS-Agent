import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	FoundationError,
	type ConnectorCapabilitySnapshot,
} from "@aos-agent/agent-core";
import type { ProductionExternalConnectorProcessWithProvenance } from "./external-connector-process-controller.ts";

export const EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION = 1 as const;

export type ExternalConnectorTargetAuthority = "managed" | "global";
export type ExternalConnectorTargetSelectionSource = "explicit" | "project" | "role";
export type ExternalConnectorModelAccess = ConnectorCapabilitySnapshot["modelAccess"];

export interface ExternalConnectorCapabilityCeiling {
	readonly modelAccess: readonly ExternalConnectorModelAccess[];
	readonly resume: boolean;
	readonly toolGateway: boolean;
	readonly artifacts: boolean;
	readonly images: boolean;
}

export interface ExternalConnectorCapabilityNarrowing {
	readonly modelAccess?: readonly ExternalConnectorModelAccess[];
	readonly resume?: boolean;
	readonly toolGateway?: boolean;
	readonly artifacts?: boolean;
	readonly images?: boolean;
}

/** Opaque account identity only. Credential material is not part of this schema. */
export interface ExternalConnectorAccountReference {
	readonly schemaVersion: 1;
	readonly namespace: string;
	readonly accountId: string;
}

/** Trusted global/managed definition. No environment, headers, or raw credential fields are accepted. */
export interface ExternalConnectorTargetDefinition {
	readonly schemaVersion: 1;
	readonly targetId: string;
	readonly providerId: string;
	readonly executablePath: string;
	readonly modulePath: string;
	readonly cwd: string;
	readonly version: string;
	readonly executableIdentity: string;
	readonly moduleIdentity: string;
	readonly endpoint?: string;
	readonly accountReference?: ExternalConnectorAccountReference;
	readonly capabilityCeiling: ExternalConnectorCapabilityCeiling;
}

export interface ExternalConnectorTargetCatalogConfig {
	readonly schemaVersion: 1;
	readonly targets: readonly ExternalConnectorTargetDefinition[];
}

/** Project and Role values can name a trusted target and narrow its ceiling only. */
export interface ExternalConnectorTargetSelectionConfig {
	readonly schemaVersion: 1;
	readonly targetId?: string;
	readonly capabilityCeiling?: ExternalConnectorCapabilityNarrowing;
}

export interface ExternalConnectorTrustedTarget extends ExternalConnectorTargetDefinition {
	readonly source: ExternalConnectorTargetAuthority;
}

export interface ExternalConnectorResolvedTarget extends ExternalConnectorTrustedTarget {
	readonly selectionSources: readonly ExternalConnectorTargetSelectionSource[];
	readonly selectionRevision: string;
}

export interface ExternalConnectorTargetConfig {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION;
	readonly targets: readonly ExternalConnectorTrustedTarget[];
	readonly selectedTarget?: ExternalConnectorResolvedTarget;
	readonly configRevision: string;
}

export interface ExternalConnectorTargetConfigBuildOptions {
	/** Host-managed target catalog. */
	readonly managed?: unknown;
	/** Host-global target catalog. */
	readonly global?: unknown;
	/** Project selection/narrowing. It is rejected without an explicit Host trust decision. */
	readonly project?: unknown;
	readonly projectTrusted?: boolean;
	/** Canonical Role selection/narrowing. It is rejected without an explicit Host trust decision. */
	readonly role?: unknown;
	readonly roleTrusted?: boolean;
	/** Stable CLI/SDK target selector. Catalog order is never used for selection. */
	readonly explicitTargetId?: unknown;
}

export type ExternalConnectorTargetConfigErrorReason =
	| "invalid_shape"
	| "untrusted_source"
	| "ambiguous_target"
	| "ambiguous_selection"
	| "target_not_found"
	| "capability_widened";

/** Safe configuration failure. `path` identifies a field but never contains its value. */
export class ExternalConnectorTargetConfigError extends FoundationError {
	readonly reason: ExternalConnectorTargetConfigErrorReason;
	readonly path: string;

	constructor(reason: ExternalConnectorTargetConfigErrorReason, path: string, message: string) {
		super("external_connector_config_invalid", message);
		this.name = "ExternalConnectorTargetConfigError";
		this.reason = reason;
		this.path = path;
	}
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const SHA256_IDENTITY_PATTERN = /^sha256:[A-Fa-f0-9]{64}$/;
const PATH_MAX_BYTES = 32 * 1024;
const ENDPOINT_MAX_BYTES = 2 * 1024;
const TARGET_LIMIT = 128;
const MODEL_ACCESS_ORDER = Object.freeze([
	"none",
	"agent_owned",
	"aos_gateway",
] as const satisfies readonly ExternalConnectorModelAccess[]);
const MODEL_ACCESS_VALUES: ReadonlySet<string> = new Set(MODEL_ACCESS_ORDER);
const CATALOG_KEYS = new Set(["schemaVersion", "targets"]);
const TARGET_KEYS = new Set([
	"schemaVersion",
	"targetId",
	"providerId",
	"executablePath",
	"modulePath",
	"cwd",
	"version",
	"executableIdentity",
	"moduleIdentity",
	"endpoint",
	"accountReference",
	"capabilityCeiling",
]);
const ACCOUNT_REFERENCE_KEYS = new Set(["schemaVersion", "namespace", "accountId"]);
const CAPABILITY_CEILING_KEYS = new Set([
	"modelAccess",
	"resume",
	"toolGateway",
	"artifacts",
	"images",
]);
const SELECTION_KEYS = new Set(["schemaVersion", "targetId", "capabilityCeiling"]);
const TRUSTED_TARGET_CONFIGS = new WeakSet<object>();
const TRUSTED_RESOLVED_TARGETS = new WeakSet<object>();

function fail(
	reason: ExternalConnectorTargetConfigErrorReason,
	path: string,
	message: string,
): never {
	throw new ExternalConnectorTargetConfigError(reason, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail("invalid_shape", path, "External Connector configuration value must be an object.");
	return value;
}

function requireExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowed.has(key)) {
			fail("invalid_shape", typeof key === "string" ? `${path}.${key}` : path, "External Connector configuration contains an unknown field.");
		}
	}
}

function requireSchemaVersion(value: Record<string, unknown>, path: string): void {
	if (value.schemaVersion !== EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION) {
		fail("invalid_shape", `${path}.schemaVersion`, "External Connector configuration schema version is unsupported.");
	}
}

function parseIdentifier(value: unknown, path: string): string {
	if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
		fail("invalid_shape", path, "External Connector identifier is invalid.");
	}
	return value;
}

function parseAbsolutePath(value: unknown, path: string): string {
	if (
		typeof value !== "string" ||
		!isAbsolute(value) ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES
	) {
		fail("invalid_shape", path, "External Connector target path must be a bounded absolute path.");
	}
	return value;
}

function parseVersion(value: unknown, path: string): string {
	if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
		fail("invalid_shape", path, "External Connector target version is invalid.");
	}
	return value;
}

function parseIdentity(value: unknown, path: string): string {
	if (typeof value !== "string" || !SHA256_IDENTITY_PATTERN.test(value)) {
		fail("invalid_shape", path, "External Connector file identity must be a SHA-256 reference.");
	}
	return value.toLowerCase();
}

function parseEndpoint(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > ENDPOINT_MAX_BYTES) {
		fail("invalid_shape", path, "External Connector endpoint is invalid.");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		return fail("invalid_shape", path, "External Connector endpoint is invalid.");
	}
	const loopback =
		endpoint.hostname === "localhost" ||
		endpoint.hostname.endsWith(".localhost") ||
		endpoint.hostname === "127.0.0.1" ||
		endpoint.hostname === "[::1]";
	if (
		(endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
		endpoint.username.length > 0 ||
		endpoint.password.length > 0 ||
		endpoint.search.length > 0 ||
		endpoint.hash.length > 0
	) {
		fail("invalid_shape", path, "External Connector endpoint must be credential-free HTTPS or loopback HTTP.");
	}
	return endpoint.href;
}

function parseAccountReference(value: unknown, path: string): ExternalConnectorAccountReference | undefined {
	if (value === undefined) return undefined;
	const record = requireRecord(value, path);
	requireExactKeys(record, ACCOUNT_REFERENCE_KEYS, path);
	requireSchemaVersion(record, path);
	return Object.freeze({
		schemaVersion: 1 as const,
		namespace: parseIdentifier(record.namespace, `${path}.namespace`),
		accountId: parseIdentifier(record.accountId, `${path}.accountId`),
	});
}

function parseModelAccess(value: unknown, path: string): readonly ExternalConnectorModelAccess[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MODEL_ACCESS_ORDER.length) {
		fail("invalid_shape", path, "External Connector model-access ceiling must be a non-empty bounded list.");
	}
	const entries = value.map((entry, index) => {
		if (typeof entry !== "string" || !MODEL_ACCESS_VALUES.has(entry)) {
			fail("invalid_shape", `${path}[${index}]`, "External Connector model-access ceiling is invalid.");
		}
		return entry as ExternalConnectorModelAccess;
	});
	if (new Set(entries).size !== entries.length) {
		fail("invalid_shape", path, "External Connector model-access ceiling contains duplicates.");
	}
	return Object.freeze(MODEL_ACCESS_ORDER.filter((entry) => entries.includes(entry)));
}

function parseBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail("invalid_shape", path, "External Connector capability ceiling must be boolean.");
	return value;
}

function parseCapabilityCeiling(value: unknown, path: string): ExternalConnectorCapabilityCeiling {
	const record = requireRecord(value, path);
	requireExactKeys(record, CAPABILITY_CEILING_KEYS, path);
	for (const key of CAPABILITY_CEILING_KEYS) {
		if (!Object.hasOwn(record, key)) fail("invalid_shape", `${path}.${key}`, "External Connector capability ceiling is incomplete.");
	}
	return Object.freeze({
		modelAccess: parseModelAccess(record.modelAccess, `${path}.modelAccess`),
		resume: parseBoolean(record.resume, `${path}.resume`),
		toolGateway: parseBoolean(record.toolGateway, `${path}.toolGateway`),
		artifacts: parseBoolean(record.artifacts, `${path}.artifacts`),
		images: parseBoolean(record.images, `${path}.images`),
	});
}

function parseCapabilityNarrowing(value: unknown, path: string): ExternalConnectorCapabilityNarrowing {
	const record = requireRecord(value, path);
	requireExactKeys(record, CAPABILITY_CEILING_KEYS, path);
	return Object.freeze({
		...(record.modelAccess === undefined
			? {}
			: { modelAccess: parseModelAccess(record.modelAccess, `${path}.modelAccess`) }),
		...(record.resume === undefined ? {} : { resume: parseBoolean(record.resume, `${path}.resume`) }),
		...(record.toolGateway === undefined
			? {}
			: { toolGateway: parseBoolean(record.toolGateway, `${path}.toolGateway`) }),
		...(record.artifacts === undefined ? {} : { artifacts: parseBoolean(record.artifacts, `${path}.artifacts`) }),
		...(record.images === undefined ? {} : { images: parseBoolean(record.images, `${path}.images`) }),
	});
}

function parseTargetDefinition(
	value: unknown,
	source: ExternalConnectorTargetAuthority,
	path: string,
): ExternalConnectorTrustedTarget {
	const record = requireRecord(value, path);
	requireExactKeys(record, TARGET_KEYS, path);
	requireSchemaVersion(record, path);
	const endpoint = parseEndpoint(record.endpoint, `${path}.endpoint`);
	const accountReference = parseAccountReference(record.accountReference, `${path}.accountReference`);
	return Object.freeze({
		schemaVersion: 1 as const,
		targetId: parseIdentifier(record.targetId, `${path}.targetId`),
		providerId: parseIdentifier(record.providerId, `${path}.providerId`),
		executablePath: parseAbsolutePath(record.executablePath, `${path}.executablePath`),
		modulePath: parseAbsolutePath(record.modulePath, `${path}.modulePath`),
		cwd: parseAbsolutePath(record.cwd, `${path}.cwd`),
		version: parseVersion(record.version, `${path}.version`),
		executableIdentity: parseIdentity(record.executableIdentity, `${path}.executableIdentity`),
		moduleIdentity: parseIdentity(record.moduleIdentity, `${path}.moduleIdentity`),
		...(endpoint === undefined ? {} : { endpoint }),
		...(accountReference === undefined ? {} : { accountReference }),
		capabilityCeiling: parseCapabilityCeiling(record.capabilityCeiling, `${path}.capabilityCeiling`),
		source,
	});
}

function parseCatalog(
	value: unknown,
	source: ExternalConnectorTargetAuthority,
): readonly ExternalConnectorTrustedTarget[] {
	if (value === undefined) return [];
	const path = `$.${source}`;
	const record = requireRecord(value, path);
	requireExactKeys(record, CATALOG_KEYS, path);
	requireSchemaVersion(record, path);
	if (!Array.isArray(record.targets) || record.targets.length > TARGET_LIMIT) {
		fail("invalid_shape", `${path}.targets`, "External Connector target catalog must be a bounded array.");
	}
	return Object.freeze(
		record.targets.map((target, index) => parseTargetDefinition(target, source, `${path}.targets[${index}]`)),
	);
}

function parseSelection(value: unknown, source: "project" | "role"): ExternalConnectorTargetSelectionConfig | undefined {
	if (value === undefined) return undefined;
	const path = `$.${source}`;
	const record = requireRecord(value, path);
	requireExactKeys(record, SELECTION_KEYS, path);
	requireSchemaVersion(record, path);
	return Object.freeze({
		schemaVersion: 1 as const,
		...(record.targetId === undefined ? {} : { targetId: parseIdentifier(record.targetId, `${path}.targetId`) }),
		...(record.capabilityCeiling === undefined
			? {}
			: { capabilityCeiling: parseCapabilityNarrowing(record.capabilityCeiling, `${path}.capabilityCeiling`) }),
	});
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function revisionFor(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function narrowCapabilities(
	base: ExternalConnectorCapabilityCeiling,
	narrowing: ExternalConnectorCapabilityNarrowing | undefined,
	path: string,
): ExternalConnectorCapabilityCeiling {
	if (narrowing === undefined) return base;
	if (narrowing.modelAccess?.some((entry) => !base.modelAccess.includes(entry))) {
		fail("capability_widened", `${path}.modelAccess`, "External Connector selection cannot widen model access.");
	}
	for (const key of ["resume", "toolGateway", "artifacts", "images"] as const) {
		if (narrowing[key] === true && base[key] === false) {
			fail("capability_widened", `${path}.${key}`, "External Connector selection cannot widen a capability ceiling.");
		}
	}
	return Object.freeze({
		modelAccess: narrowing.modelAccess ?? base.modelAccess,
		resume: narrowing.resume ?? base.resume,
		toolGateway: narrowing.toolGateway ?? base.toolGateway,
		artifacts: narrowing.artifacts ?? base.artifacts,
		images: narrowing.images ?? base.images,
	});
}

/**
 * Build one immutable trusted catalog and resolve only an explicit target.
 * Catalog order, provider load, and implicit single-target fallback never select a target.
 */
export function buildExternalConnectorTargetConfig(
	options: ExternalConnectorTargetConfigBuildOptions = {},
): ExternalConnectorTargetConfig {
	if (options.project !== undefined && options.projectTrusted !== true) {
		fail("untrusted_source", "$.project", "External Connector project selection requires a trusted Host source decision.");
	}
	if (options.role !== undefined && options.roleTrusted !== true) {
		fail("untrusted_source", "$.role", "External Connector Role selection requires a trusted Host source decision.");
	}
	const targets = [...parseCatalog(options.managed, "managed"), ...parseCatalog(options.global, "global")];
	const targetsById = new Map<string, ExternalConnectorTrustedTarget>();
	for (const target of targets) {
		if (targetsById.has(target.targetId)) {
			fail("ambiguous_target", "$.targets", "External Connector target identity is ambiguous across trusted catalogs.");
		}
		targetsById.set(target.targetId, target);
	}
	const sortedTargets = Object.freeze([...targetsById.values()].sort((left, right) => left.targetId.localeCompare(right.targetId)));
	const project = parseSelection(options.project, "project");
	const role = parseSelection(options.role, "role");
	const explicitTargetId = options.explicitTargetId === undefined
		? undefined
		: parseIdentifier(options.explicitTargetId, "$.explicitTargetId");
	const selectedIds = [explicitTargetId, project?.targetId, role?.targetId].filter(
		(value): value is string => value !== undefined,
	);
	if (new Set(selectedIds).size > 1) {
		fail("ambiguous_selection", "$.selection", "External Connector target selectors disagree.");
	}
	const selectedTargetId = selectedIds[0];
	const hasNarrowing = project?.capabilityCeiling !== undefined || role?.capabilityCeiling !== undefined;
	if (selectedTargetId === undefined && hasNarrowing) {
		fail("ambiguous_selection", "$.selection", "External Connector capability narrowing requires an explicit target.");
	}

	let selectedTarget: ExternalConnectorResolvedTarget | undefined;
	if (selectedTargetId !== undefined) {
		const target = targetsById.get(selectedTargetId);
		if (target === undefined) {
			fail("target_not_found", "$.selection", "External Connector selection must name a trusted target.");
		}
		let capabilityCeiling = narrowCapabilities(target.capabilityCeiling, project?.capabilityCeiling, "$.project.capabilityCeiling");
		capabilityCeiling = narrowCapabilities(capabilityCeiling, role?.capabilityCeiling, "$.role.capabilityCeiling");
		const selectionSources = Object.freeze([
			...(explicitTargetId === undefined ? [] : ["explicit" as const]),
			...(project === undefined ? [] : ["project" as const]),
			...(role === undefined ? [] : ["role" as const]),
		]);
		const selectionRevision = revisionFor({ target, capabilityCeiling, selectionSources });
		selectedTarget = deepFreeze({
			...target,
			capabilityCeiling,
			selectionSources,
			selectionRevision,
		});
		TRUSTED_RESOLVED_TARGETS.add(selectedTarget);
	}

	const config = deepFreeze({
		schemaVersion: EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION,
		targets: sortedTargets,
		...(selectedTarget === undefined ? {} : { selectedTarget }),
		configRevision: revisionFor({
			schemaVersion: EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION,
			targets: sortedTargets,
			selectedTarget,
		}),
	});
	TRUSTED_TARGET_CONFIGS.add(config);
	return config;
}

export const resolveExternalConnectorTargetConfig = buildExternalConnectorTargetConfig;

/** Runtime attestation used by trusted composition; structural lookalikes are rejected. */
export function isTrustedExternalConnectorTargetConfig(value: unknown): value is ExternalConnectorTargetConfig {
	return isRecord(value) && TRUSTED_TARGET_CONFIGS.has(value);
}

/** Runtime attestation used by production composition; project-created lookalikes are rejected. */
export function isTrustedExternalConnectorResolvedTarget(value: unknown): value is ExternalConnectorResolvedTarget {
	return isRecord(value) && TRUSTED_RESOLVED_TARGETS.has(value);
}

/** Reject a declared runtime snapshot that exceeds the selected target ceiling. */
export function assertExternalConnectorCapabilityWithinTarget(
	target: ExternalConnectorResolvedTarget,
	capability: ConnectorCapabilitySnapshot,
): void {
	if (!isTrustedExternalConnectorResolvedTarget(target)) {
		fail("untrusted_source", "$.target", "External Connector target was not resolved by the trusted Host configuration.");
	}
	if (
		capability.providerId !== target.providerId ||
		!target.capabilityCeiling.modelAccess.includes(capability.modelAccess)
	) {
		fail("capability_widened", "$.capability", "External Connector capability exceeds its selected target ceiling.");
	}
	for (const key of ["resume", "toolGateway", "artifacts", "images"] as const) {
		if (capability[key] && !target.capabilityCeiling[key]) {
			fail("capability_widened", `$.capability.${key}`, "External Connector capability exceeds its selected target ceiling.");
		}
	}
}

/** Convert one attested target into the existing no-shell production process contract. */
export function externalConnectorProcessForTarget(
	target: ExternalConnectorResolvedTarget,
): ProductionExternalConnectorProcessWithProvenance {
	if (!isTrustedExternalConnectorResolvedTarget(target)) {
		fail("untrusted_source", "$.target", "External Connector target was not resolved by the trusted Host configuration.");
	}
	return Object.freeze({
		executablePath: target.executablePath,
		...(target.modulePath === target.executablePath ? {} : { arguments: Object.freeze([target.modulePath]) }),
		trustedProvenance: Object.freeze({
			modulePath: target.modulePath,
			cwd: target.cwd,
			version: target.version,
			executableIdentity: target.executableIdentity,
			moduleIdentity: target.moduleIdentity,
		}),
	});
}
