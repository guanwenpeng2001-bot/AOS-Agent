import type {
	CapabilityCandidate,
	CapabilityDecision,
	CapabilityKind,
	CapabilityProfile,
	CapabilityProfileRule,
	CapabilitySelector,
} from "./capability-registry.ts";
import { mcpRedirectUrlProblem } from "./mcp-auth.ts";
import type {
	MCPPromptSummary,
	MCPResourceSummary,
	MCPResourceTemplateSummary,
} from "./mcp-types.ts";
import { createSyntheticSourceInfo, type SourceInfo, type SourceScope } from "./source-info.ts";

/**
 * v1 settings parsing and trust for the Capability Registry.
 *
 * This module owns the safe parsing of `capabilities.defaultProfile` /
 * `capabilities.profiles` and `mcp.servers`, and the trust-aware merge of
 * global and project settings. It never stores env/header/token values: MCP
 * config may only reference environment variable names, so the parsed result
 * is inherently secret-free and safe to expose through redacted views.
 */

/** The scope an MCP server config was declared in. */
export type McpServerScope = "global" | "project";

export type CapabilitySettingsErrorCode =
	| "capability_settings_invalid_selector"
	| "capability_settings_invalid_profile"
	| "capability_settings_profile_not_found"
	| "capability_settings_invalid_server_id"
	| "capability_settings_duplicate_server_id"
	| "capability_settings_invalid_server"
	| "capability_settings_invalid_url"
	| "capability_settings_invalid_env"
	| "capability_settings_invalid_header"
	| "capability_settings_secret_argument";

export class CapabilitySettingsError extends Error {
	readonly code: CapabilitySettingsErrorCode;
	readonly path: string;

	constructor(code: CapabilitySettingsErrorCode, message: string, path = "") {
		super(path !== "" ? `${path}: ${message}` : message);
		this.name = "CapabilitySettingsError";
		this.code = code;
		this.path = path;
	}
}

/** Raw `capabilities` settings as they appear in a settings file. */
export interface CapabilitiesSettingsConfig {
	defaultProfile?: string;
	profiles?: Record<string, unknown>;
}

/** Raw `mcp` settings as they appear in a settings file. */
export interface McpSettingsConfig {
	servers?: Record<string, unknown>;
}

/** Validated stdio MCP server config. */
export interface McpStdioServer {
	transport: "stdio";
	command: string;
	args: ReadonlyArray<string>;
	env: ReadonlyArray<string>;
}

/** Validated streamable-http MCP server config. */
export interface McpStreamableHttpServer {
	transport: "streamable-http";
	url: string;
	headersFromEnv: ReadonlyArray<McpHeaderFromEnv>;
	/** Optional secret-free OAuth settings. Tokens and client secrets are rejected. */
	oauth?: McpOAuthConfig;
}

/**
 * OAuth settings for one Streamable HTTP MCP server. All values are
 * secret-free: tokens and client secrets never appear in settings.
 */
export interface McpOAuthConfig {
	/** Authorization callback; https or an http loopback address. */
	redirectUrl: string;
	/** Explicit canonical RFC 8707 resource override. */
	canonicalResource?: string;
	/** Static public client id; dynamic registration is used when absent. */
	clientId?: string;
	/** Optional scope requested on authorization. */
	scope?: string;
	/** Client name used for dynamic registration metadata. */
	clientName?: string;
}

export interface McpHeaderFromEnv {
	name: string;
	valueFromEnv: string;
}

export type McpServer = McpStdioServer | McpStreamableHttpServer;

/** A validated MCP server config carrying its trust and derived source. */
export interface McpServerDiagnostic {
	id: string;
	scope: McpServerScope;
	trusted: boolean;
	source: SourceInfo;
	server: McpServer;
}

/** Trust-aware merged capability settings ready for the Registry. */
export interface CapabilitySettings {
	/** Resolved default profile name; always present and defined in {@link profiles}. */
	defaultProfile: string;
	profiles: Readonly<Record<string, CapabilityProfile>>;
	/** Ordered across scopes: global servers first, then project servers. */
	mcpServers: ReadonlyArray<McpServerDiagnostic>;
}

/** Raw input for {@link buildCapabilitySettings}; fields are unvalidated JSON. */
export interface CapabilitySettingsInput {
	capabilities?: unknown;
	mcp?: unknown;
}

export interface McpServerSettingsView {
	id: string;
	scope: McpServerScope;
	trusted: boolean;
	transport: "stdio" | "streamable-http";
	command?: string;
	args?: ReadonlyArray<string>;
	env?: ReadonlyArray<string>;
	url?: string;
	headersFromEnv?: ReadonlyArray<McpHeaderFromEnv>;
	oauth?: McpOAuthSettingsView;
}

/** Secret-free OAuth settings view; URLs are redacted. */
export interface McpOAuthSettingsView {
	redirectUrl: string;
	canonicalResource?: string;
	clientId?: string;
	scope?: string;
	clientName?: string;
}

export interface CapabilitySettingsView {
	defaultProfile: string;
	profiles: Readonly<Record<string, CapabilityProfile>>;
	mcpServers: ReadonlyArray<McpServerSettingsView>;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);
const VALID_KINDS: ReadonlySet<string> = new Set<CapabilityKind>([
	"builtin_tool",
	"extension_tool",
	"sdk_tool",
	"skill",
	"extension",
	"mcp_server",
	"mcp_tool",
	"mcp_resource",
	"mcp_resource_template",
	"mcp_prompt",
]);
const VALID_SCOPES: ReadonlySet<string> = new Set<SourceScope>(["user", "project", "temporary"]);
const SELECTOR_KEYS: ReadonlySet<string> = new Set(["id", "kind", "sourceId", "scope", "mcpServerId", "parentId"]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Literal secret values that must never appear in config: common token
 * prefixes, JWTs, and `Bearer <token>` forms.
 */
const LITERAL_SECRET_PATTERN =
	/(?:\bsk-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{6,}|\bsk_live_[A-Za-z0-9]{16,}|\bsk_test_[A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{6,})/;

/** Literal header/cookie lines, e.g. `Authorization: Bearer <token>`. */
const LITERAL_HEADER_PATTERN =
	/^(?:Authorization|Cookie|Proxy-Authorization|X-API-Key|X-Auth-Token|Api-Key|Auth|Set-Cookie):\s*\S/i;

/** Flag names that carry credentials; rejected in any argv position. */
const SECRET_FLAG_SEGMENT_PATTERN =
	/(?:^|[_-])(?:token|secret|passwd|password|api[_-]?key|apikey|key|credential|cookie|auth|header|bearer)(?:[_-]|$)/i;

/** Query parameter names that carry credentials; forbidden in MCP URLs. */
const CREDENTIAL_QUERY_PARAM_PATTERN =
	/(?:^|[_-])(?:key|token|secret|passwd|password|api[_-]?key|apikey|credential|cookie|auth|signature|sig)(?:[_-]|$)/i;

function hasControlChars(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function settingsError(
	code: CapabilitySettingsErrorCode,
	path: string,
	message: string,
): never {
	throw new CapabilitySettingsError(code, message, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

function parseSelector(raw: unknown, path: string): CapabilitySelector {
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_selector", path, "must be an object");
	}
	const keys = Object.keys(raw);
	for (const key of keys) {
		if (!SELECTOR_KEYS.has(key)) {
			settingsError("capability_settings_invalid_selector", `${path}.${key}`, "unknown selector field");
		}
	}
	if (keys.length === 0) {
		settingsError("capability_settings_invalid_selector", path, "selector must not be empty");
	}
	const selector: CapabilitySelector = {};
	for (const key of keys) {
		const value = raw[key];
		if (typeof value !== "string" || value === "") {
			settingsError("capability_settings_invalid_selector", `${path}.${key}`, "must be a non-empty string");
		}
		switch (key) {
			case "kind": {
				if (!VALID_KINDS.has(value)) {
					settingsError("capability_settings_invalid_selector", `${path}.kind`, `unknown capability kind "${value}"`);
				}
				selector.kind = value as CapabilityKind;
				break;
			}
			case "scope": {
				if (!VALID_SCOPES.has(value)) {
					settingsError("capability_settings_invalid_selector", `${path}.scope`, `unknown scope "${value}"`);
				}
				selector.scope = value as SourceScope;
				break;
			}
			case "id":
				selector.id = value;
				break;
			case "sourceId":
				selector.sourceId = value;
				break;
			case "mcpServerId":
				selector.mcpServerId = value;
				break;
			case "parentId":
				selector.parentId = value;
				break;
		}
	}
	return selector;
}

function parseRule(raw: unknown, path: string): CapabilityProfileRule {
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_selector", path, "rule must be an object");
	}
	const allowed = new Set(["selector", "action"]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			settingsError("capability_settings_invalid_selector", `${path}.${key}`, "unknown rule field");
		}
	}
	if (raw.selector === undefined) {
		settingsError("capability_settings_invalid_selector", path, "missing selector");
	}
	if (raw.action === undefined) {
		settingsError("capability_settings_invalid_selector", path, "missing action");
	}
	if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action)) {
		settingsError("capability_settings_invalid_selector", `${path}.action`, "action must be allow, ask or deny");
	}
	return {
		selector: parseSelector(raw.selector, `${path}.selector`),
		action: raw.action as CapabilityDecision,
	};
}

function parseProfile(raw: unknown, path: string): CapabilityProfile {
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_profile", path, "must be an object with a rules array");
	}
	const allowed = new Set(["rules"]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			settingsError("capability_settings_invalid_profile", `${path}.${key}`, "unknown profile field");
		}
	}
	if (raw.rules === undefined) {
		settingsError("capability_settings_invalid_profile", path, "missing rules");
	}
	if (!Array.isArray(raw.rules)) {
		settingsError("capability_settings_invalid_profile", `${path}.rules`, "must be an array");
	}
	const rules = raw.rules.map((rule, index) => parseRule(rule, `${path}.rules[${index}]`));
	return { rules };
}

function parseProfiles(raw: unknown, path: string): Record<string, CapabilityProfile> {
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_profile", path, "must be an object");
	}
	const out: Record<string, CapabilityProfile> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (name.trim() === "" || name !== name.trim() || hasControlChars(name)) {
			settingsError("capability_settings_invalid_profile", `${path}.${name}`, "invalid profile name");
		}
		out[name] = parseProfile(value, `${path}.${name}`);
	}
	return out;
}

function parseCapabilities(
	raw: unknown,
	path: string,
): { defaultProfile?: string; profiles: Record<string, CapabilityProfile> } {
	if (raw === undefined || raw === null) {
		return { profiles: {} };
	}
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_profile", path, "must be an object");
	}
	const allowed = new Set(["defaultProfile", "profiles"]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			settingsError("capability_settings_invalid_profile", `${path}.${key}`, "unknown capabilities field");
		}
	}
	let defaultProfile: string | undefined;
	if (raw.defaultProfile !== undefined) {
		if (typeof raw.defaultProfile !== "string" || raw.defaultProfile.trim() === "") {
			settingsError("capability_settings_invalid_profile", `${path}.defaultProfile`, "must be a non-empty string");
		}
		defaultProfile = raw.defaultProfile;
	}
	let profiles: Record<string, CapabilityProfile> = {};
	if (raw.profiles !== undefined) {
		profiles = parseProfiles(raw.profiles, `${path}.profiles`);
	}
	return {
		...(defaultProfile !== undefined ? { defaultProfile } : {}),
		profiles,
	};
}

function validateServerId(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		settingsError("capability_settings_invalid_server_id", path, "server id must be a non-empty string");
	}
	if (value.includes("__")) {
		settingsError(
			"capability_settings_invalid_server_id",
			path,
			"server id must not contain a double underscore (reserved for MCP tool namespacing)",
		);
	}
	if (value !== value.trim() || hasControlChars(value)) {
		settingsError("capability_settings_invalid_server_id", path, "server id must not contain whitespace or control characters");
	}
	return value;
}

function validateCommand(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		settingsError("capability_settings_invalid_server", path, "command must be a non-empty string");
	}
	if (hasControlChars(value)) {
		settingsError("capability_settings_invalid_server", path, "command must not contain control characters");
	}
	return value;
}

function validateEnvNames(value: unknown, path: string): ReadonlyArray<string> {
	if (!Array.isArray(value)) {
		settingsError("capability_settings_invalid_env", path, "env must be an array of environment variable names");
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (typeof item !== "string" || !ENV_NAME_PATTERN.test(item)) {
			settingsError(
				"capability_settings_invalid_env",
				`${path}[${index}]`,
				"must be a valid environment variable name; config may only reference env names, never values",
			);
		}
		out.push(item);
	}
	return out;
}

function isLiteralSecret(value: string): boolean {
	return LITERAL_SECRET_PATTERN.test(value);
}

function isSecretFlagName(flag: string): boolean {
	return SECRET_FLAG_SEGMENT_PATTERN.test(flag.replace(/^--?/, ""));
}

function isBareSecretFlag(arg: string): boolean {
	return arg.startsWith("-") && !arg.includes("=") && isSecretFlagName(arg);
}

function assertBenignArg(arg: string, path: string): void {
	if (isLiteralSecret(arg)) {
		settingsError("capability_settings_secret_argument", path, "argument contains a literal token value");
	}
	if (LITERAL_HEADER_PATTERN.test(arg)) {
		settingsError("capability_settings_secret_argument", path, "argument contains a literal header or cookie value");
	}
	const eq = arg.indexOf("=");
	if (arg.startsWith("-") && eq > 0) {
		const flag = arg.slice(0, eq);
		const value = arg.slice(eq + 1);
		if (isSecretFlagName(flag) && value !== "") {
			settingsError("capability_settings_secret_argument", path, "credential-bearing flag must not carry an inline value");
		}
	}
}

function validateArgs(value: unknown, path: string): ReadonlyArray<string> {
	if (!Array.isArray(value)) {
		settingsError("capability_settings_invalid_server", path, "args must be an array of strings");
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (typeof item !== "string") {
			settingsError("capability_settings_invalid_server", `${path}[${index}]`, "must be a string");
		}
		assertBenignArg(item, `${path}[${index}]`);
		// A bare credential flag followed by a value embeds that value in config.
		if (isBareSecretFlag(item) && index + 1 < value.length && !value[index + 1].startsWith("-")) {
			settingsError(
				"capability_settings_secret_argument",
				`${path}[${index}]`,
				"credential-bearing flag must not be followed by a literal value",
			);
		}
		out.push(item);
	}
	return out;
}

function validateUrl(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		settingsError("capability_settings_invalid_url", path, "url must be a non-empty string");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		settingsError("capability_settings_invalid_url", path, "url must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		settingsError("capability_settings_invalid_url", path, "url must use http or https");
	}
	if (parsed.hostname === "") {
		settingsError("capability_settings_invalid_url", path, "url must include a host");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		settingsError("capability_settings_invalid_url", path, "url must not contain userinfo");
	}
	for (const [name, paramValue] of parsed.searchParams.entries()) {
		if (CREDENTIAL_QUERY_PARAM_PATTERN.test(name)) {
			settingsError("capability_settings_invalid_url", path, `url query must not contain a credential parameter "${name}"`);
		}
		if (isLiteralSecret(paramValue)) {
			settingsError("capability_settings_invalid_url", path, "url query must not contain a literal token value");
		}
	}
	return value;
}

function validateHeaders(value: unknown, path: string): ReadonlyArray<McpHeaderFromEnv> {
	if (!Array.isArray(value)) {
		settingsError("capability_settings_invalid_header", path, "headersFromEnv must be an array");
	}
	const out: McpHeaderFromEnv[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		if (!isPlainObject(item)) {
			settingsError("capability_settings_invalid_header", `${path}[${index}]`, "must be an object with name and valueFromEnv");
		}
		const allowed = new Set(["name", "valueFromEnv"]);
		for (const key of Object.keys(item)) {
			if (!allowed.has(key)) {
				settingsError("capability_settings_invalid_header", `${path}[${index}].${key}`, "unknown header field");
			}
		}
		const { name, valueFromEnv } = item;
		if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) {
			settingsError("capability_settings_invalid_header", `${path}[${index}].name`, "must be a valid HTTP header name");
		}
		if (typeof valueFromEnv !== "string" || !ENV_NAME_PATTERN.test(valueFromEnv)) {
			settingsError(
				"capability_settings_invalid_header",
				`${path}[${index}].valueFromEnv`,
				"must be a valid environment variable name; headers may only reference env names, never values",
			);
		}
		if (seen.has(name.toLowerCase())) {
			settingsError("capability_settings_invalid_header", `${path}[${index}].name`, `duplicate header "${name}"`);
		}
		seen.add(name.toLowerCase());
		out.push({ name, valueFromEnv });
	}
	return out;
}

function parseMcpOAuthConfig(value: unknown, path: string): McpOAuthConfig | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isPlainObject(value)) {
		settingsError("capability_settings_invalid_server", path, "oauth must be an object");
	}
	const allowed = new Set(["redirectUrl", "canonicalResource", "clientId", "scope", "clientName"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			settingsError("capability_settings_invalid_server", `${path}.${key}`, "unknown oauth field");
		}
	}
	const { redirectUrl, canonicalResource, clientId, scope, clientName } = value;
	if (typeof redirectUrl !== "string" || redirectUrl.trim() === "") {
		settingsError("capability_settings_invalid_server", `${path}.redirectUrl`, "oauth requires a redirectUrl");
	}
	const redirectProblem = mcpRedirectUrlProblem(redirectUrl);
	if (redirectProblem !== undefined) {
		settingsError(
			"capability_settings_invalid_server",
			`${path}.redirectUrl`,
			`oauth redirectUrl ${redirectProblem}`,
		);
	}
	const out: McpOAuthConfig = { redirectUrl };
	if (canonicalResource !== undefined) {
		if (typeof canonicalResource !== "string" || canonicalResource.trim() === "") {
			settingsError("capability_settings_invalid_server", `${path}.canonicalResource`, "must be a non-empty URL");
		}
		out.canonicalResource = validateUrl(canonicalResource, `${path}.canonicalResource`);
	}
	if (clientId !== undefined) {
		if (typeof clientId !== "string" || clientId.trim() === "") {
			settingsError("capability_settings_invalid_server", `${path}.clientId`, "must be a non-empty string");
		}
		if (clientId.toLowerCase().includes("secret") || clientId.length > 256) {
			settingsError("capability_settings_invalid_server", `${path}.clientId`, "must be a bounded public client id");
		}
		out.clientId = clientId;
	}
	if (scope !== undefined) {
		if (typeof scope !== "string" || scope.trim() === "") {
			settingsError("capability_settings_invalid_server", `${path}.scope`, "must be a non-empty string");
		}
		out.scope = scope;
	}
	if (clientName !== undefined) {
		if (typeof clientName !== "string" || clientName.trim() === "") {
			settingsError("capability_settings_invalid_server", `${path}.clientName`, "must be a non-empty string");
		}
		out.clientName = clientName;
	}
	return out;
}

function parseMcpServer(value: unknown, path: string): McpServer {
	if (!isPlainObject(value)) {
		settingsError("capability_settings_invalid_server", path, "must be an object");
	}
	const allowed = new Set(["transport", "command", "args", "env", "url", "headersFromEnv", "oauth"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			settingsError("capability_settings_invalid_server", `${path}.${key}`, "unknown server field");
		}
	}
	if (value.transport === "stdio") {
		if (value.url !== undefined || value.headersFromEnv !== undefined || value.oauth !== undefined) {
			settingsError("capability_settings_invalid_server", path, "stdio servers must not set url, headersFromEnv or oauth");
		}
		if (value.command === undefined) {
			settingsError("capability_settings_invalid_server", `${path}.command`, "stdio servers require a command");
		}
		return {
			transport: "stdio",
			command: validateCommand(value.command, `${path}.command`),
			args: value.args === undefined ? [] : validateArgs(value.args, `${path}.args`),
			env: value.env === undefined ? [] : validateEnvNames(value.env, `${path}.env`),
		};
	}
	if (value.transport === "streamable-http") {
		if (value.command !== undefined || value.args !== undefined || value.env !== undefined) {
			settingsError("capability_settings_invalid_server", path, "streamable-http servers must not set command, args or env");
		}
		if (value.url === undefined) {
			settingsError("capability_settings_invalid_server", `${path}.url`, "streamable-http servers require a url");
		}
		const oauth = parseMcpOAuthConfig(value.oauth, `${path}.oauth`);
		return {
			transport: "streamable-http",
			url: validateUrl(value.url, `${path}.url`),
			headersFromEnv:
				value.headersFromEnv === undefined ? [] : validateHeaders(value.headersFromEnv, `${path}.headersFromEnv`),
			...(oauth === undefined ? {} : { oauth }),
		};
	}
	settingsError(
		"capability_settings_invalid_server",
		`${path}.transport`,
		'must be "stdio" or "streamable-http"',
	);
}

function parseMcpServers(
	raw: unknown,
	path: string,
): ReadonlyArray<{ id: string; server: McpServer }> {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!isPlainObject(raw)) {
		settingsError("capability_settings_invalid_server", path, "must be an object");
	}
	if (raw.servers === undefined) {
		return [];
	}
	if (!isPlainObject(raw.servers)) {
		settingsError("capability_settings_invalid_server", `${path}.servers`, "must be an object");
	}
	const out: Array<{ id: string; server: McpServer }> = [];
	for (const [id, config] of Object.entries(raw.servers)) {
		out.push({
			id: validateServerId(id, `${path}.servers.${id}`),
			server: parseMcpServer(config, `${path}.servers.${id}`),
		});
	}
	return out;
}

function toMcpServerDiagnostic(
	entry: { id: string; server: McpServer },
	scope: McpServerScope,
	trusted: boolean,
): McpServerDiagnostic {
	const source = createSyntheticSourceInfo(`settings://${scope}/mcp/${entry.id}`, {
		source: scope === "global" ? "mcp:global" : "mcp:project",
		scope: scope === "global" ? "user" : "project",
		origin: "top-level",
	});
	return {
		id: entry.id,
		scope,
		trusted,
		source,
		server: entry.server,
	};
}

/**
 * Parse and merge global/project capability and MCP settings under project
 * trust. Project profiles and `defaultProfile` are only merged when the
 * project is trusted; project MCP servers are always surfaced as diagnostics
 * (marked untrusted when the project is untrusted) so the Registry denies them
 * instead of ever connecting them.
 */
export function buildCapabilitySettings(options: {
	global: CapabilitySettingsInput;
	project?: CapabilitySettingsInput;
	projectTrusted: boolean;
}): CapabilitySettings {
	const globalInput = options.global ?? {};
	const projectInput = options.project ?? {};
	const trusted = options.projectTrusted;

	const globalCapabilities = parseCapabilities(globalInput.capabilities, "$.capabilities");
	let projectCapabilities: { defaultProfile?: string; profiles: Record<string, CapabilityProfile> };
	if (trusted) {
		projectCapabilities = parseCapabilities(projectInput.capabilities, "$.capabilities");
	} else {
		// Untrusted project profiles and defaultProfile are ignored entirely.
		projectCapabilities = { profiles: {} };
	}

	const profiles: Record<string, CapabilityProfile> = {
		...globalCapabilities.profiles,
		...projectCapabilities.profiles,
	};
	let defaultProfile = globalCapabilities.defaultProfile ?? "default";
	if (trusted && projectCapabilities.defaultProfile !== undefined) {
		defaultProfile = projectCapabilities.defaultProfile;
	}
	if (profiles[defaultProfile] === undefined) {
		if (defaultProfile === "default" && Object.keys(profiles).length === 0) {
			profiles.default = { rules: [] };
		} else {
			settingsError(
				"capability_settings_profile_not_found",
				"$.capabilities",
				`defaultProfile "${defaultProfile}" is not defined in capabilities.profiles`,
			);
		}
	}

	const globalServers = parseMcpServers(globalInput.mcp, "$.mcp");
	const projectServers = parseMcpServers(projectInput.mcp, "$.mcp");

	// Cross-scope duplicate server ids are rejected regardless of trust: a
	// project must never shadow or override a global server config.
	const seen = new Set<string>();
	for (const server of globalServers) {
		seen.add(server.id);
	}
	for (const server of projectServers) {
		if (seen.has(server.id)) {
			settingsError(
				"capability_settings_duplicate_server_id",
				`$.mcp.servers.${server.id}`,
				"server id is also defined in global settings; MCP server ids must be unique across scopes",
			);
		}
		seen.add(server.id);
	}

	const mcpServers: McpServerDiagnostic[] = [
		...globalServers.map((server) => toMcpServerDiagnostic(server, "global", true)),
		...projectServers.map((server) => toMcpServerDiagnostic(server, "project", trusted)),
	];

	return { defaultProfile, profiles, mcpServers };
}

/** Build the Registry candidate for an MCP server from its diagnostic. */
export function createMcpServerCapabilityCandidate(diagnostic: McpServerDiagnostic): CapabilityCandidate {
	return {
		kind: "mcp_server",
		name: diagnostic.id,
		localName: diagnostic.id,
		mcpServerId: diagnostic.id,
		sourceIdentity: diagnostic.source.source,
		source: diagnostic.source,
		trusted: diagnostic.trusted,
		revisionInput: diagnostic.server,
	};
}

/** MCP content capability kinds governed as children of an mcp_server. */
export type McpContentCapabilityKind = "mcp_resource" | "mcp_resource_template" | "mcp_prompt";

/** A discovered MCP content entry (resource, resource template, or prompt). */
export type McpContentSummary = MCPResourceSummary | MCPResourceTemplateSummary | MCPPromptSummary;

export function contentSummaryId(kind: McpContentCapabilityKind, summary: McpContentSummary): string {
	switch (kind) {
		case "mcp_resource":
			return (summary as MCPResourceSummary).resourceId;
		case "mcp_resource_template":
			return (summary as MCPResourceTemplateSummary).templateId;
		case "mcp_prompt":
			return (summary as MCPPromptSummary).promptId;
	}
}

/**
 * Build the Registry candidate for a discovered MCP resource, resource
 * template, or prompt summary from D's content normalizer.
 *
 * The candidate stays secret-free: the local name is the summary's opaque
 * digest id (the raw URI, template, or prompt name never enters the registry),
 * the revision input is the already-sanitized summary, and the provenance is
 * the summary's opaque provenance id. The parent is the owning mcp_server
 * descriptor, so server deny/ask cascades to the content child and a child can
 * only further restrict the server decision. Content capabilities never expose
 * a tool name, so they can never enter the model tool schema.
 */
export function createMcpContentCapabilityCandidate(input: {
	kind: McpContentCapabilityKind;
	server: McpServerDiagnostic;
	summary: McpContentSummary;
}): CapabilityCandidate {
	const { kind, server, summary } = input;
	return {
		kind,
		name: summary.name,
		localName: contentSummaryId(kind, summary),
		sourceIdentity: server.source.source,
		source: server.source,
		mcpServerId: server.id,
		parentId: `mcp_server:${server.source.source}:${server.id}`,
		trusted: server.trusted,
		provenance: summary.provenanceId,
		revisionInput: summary,
	};
}

/**
 * Redacted public view of the merged settings. Env/header values never exist
 * in the parsed model (only names), URLs have userinfo/query stripped, and
 * argv has already been validated to be secret-free.
 */
export function createCapabilitySettingsView(settings: CapabilitySettings): CapabilitySettingsView {
	return {
		defaultProfile: settings.defaultProfile,
		profiles: settings.profiles,
		mcpServers: settings.mcpServers.map((diagnostic) => {
			const base = { id: diagnostic.id, scope: diagnostic.scope, trusted: diagnostic.trusted };
			if (diagnostic.server.transport === "stdio") {
				return {
					...base,
					transport: "stdio" as const,
					command: diagnostic.server.command,
					args: [...diagnostic.server.args],
					env: [...diagnostic.server.env],
				};
			}
			return {
				...base,
				transport: "streamable-http" as const,
				url: redactUrl(diagnostic.server.url),
				headersFromEnv: diagnostic.server.headersFromEnv.map((header) => ({ ...header })),
				...(diagnostic.server.oauth === undefined
					? {}
					: {
							oauth: {
								redirectUrl: redactUrl(diagnostic.server.oauth.redirectUrl),
								...(diagnostic.server.oauth.canonicalResource === undefined
									? {}
									: { canonicalResource: redactUrl(diagnostic.server.oauth.canonicalResource) }),
								...(diagnostic.server.oauth.clientId === undefined
									? {}
									: { clientId: diagnostic.server.oauth.clientId }),
								...(diagnostic.server.oauth.scope === undefined ? {} : { scope: diagnostic.server.oauth.scope }),
								...(diagnostic.server.oauth.clientName === undefined
									? {}
									: { clientName: diagnostic.server.oauth.clientName }),
							},
						}),
			};
		}),
	};
}
