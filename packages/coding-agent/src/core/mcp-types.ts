import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { CapabilityAvailability, CapabilityErrorCode } from "./capability-registry.ts";

/**
 * Transport kinds supported by the MCP lifecycle v1.
 *
 * Legacy SSE is intentionally not supported.
 */
export type MCPTransportType = "stdio" | "streamable-http";

/**
 * Lifecycle states of a single MCP server connection.
 *
 *   configured -> connecting -> ready
 *   connecting -> unavailable
 *   ready -> degraded
 *   ready | degraded | unavailable -> closing -> closed
 */
export type MCPConnectionState =
	| "configured"
	| "connecting"
	| "ready"
	| "degraded"
	| "unavailable"
	| "closing"
	| "closed";

/**
 * A header whose value is resolved from an environment variable.
 *
 * Configuration only ever references the environment variable NAME; the value
 * is resolved at connection time and never stored or echoed.
 */
export interface MCPEnvReference {
	/** HTTP header name, e.g. "Authorization". */
	name: string;
	/** Environment variable name whose value supplies the header value. */
	valueFromEnv: string;
}

/** stdio server configuration. */
export interface MCPStdioServerConfig {
	id: string;
	transport: "stdio";
	/** Executable to run. */
	command: string;
	/** Command line arguments. Never surfaced in public views. */
	args?: ReadonlyArray<string>;
	/**
	 * Environment variable NAMES passed through to the child process.
	 * Values are resolved from the environment at connection time and the
	 * process environment is never inherited wholesale.
	 */
	env?: ReadonlyArray<string>;
	/** Working directory for the child process. Never surfaced in public views. */
	cwd?: string;
	/** Maximum read buffer size in bytes. */
	maxBufferSize?: number;
}

/** Streamable HTTP server configuration. */
export interface MCPStreamableHttpServerConfig {
	id: string;
	transport: "streamable-http";
	/** Server endpoint. Userinfo and credential-bearing query are rejected. */
	url: string;
	/** Headers whose values are resolved from environment variables at connect time. */
	headersFromEnv?: ReadonlyArray<MCPEnvReference>;
	/** Per-request timeout in milliseconds. */
	requestTimeoutMs?: number;
}

export type MCPServerConfig = MCPStdioServerConfig | MCPStreamableHttpServerConfig;

/** Normalized content blocks returned by a tool call. */
export type MCPToolContentBlock =
	| { type: "text"; text: string; annotations?: unknown; _meta?: unknown }
	| { type: "image"; data: string; mimeType: string; annotations?: unknown; _meta?: unknown }
	| { type: "audio"; data: string; mimeType: string; annotations?: unknown; _meta?: unknown }
	| {
			type: "resource";
			resource: { uri: string; text?: string; blob?: string; mimeType?: string };
			annotations?: unknown;
			_meta?: unknown;
	  };

/** Normalized result of calling a tool on a server. */
export interface MCPCallResult {
	serverId: string;
	toolName: string;
	content: ReadonlyArray<MCPToolContentBlock>;
	/** True when the server explicitly reported the call failed. */
	isError: boolean;
	/** Structured (non-text) output, when the server supplied it. */
	structuredContent?: Readonly<Record<string, unknown>>;
}

/** Resolves a single environment variable value; returns undefined when unset. */
export type MCPEnvResolver = (name: string) => string | undefined;

/**
 * Transport construction inputs beyond the config/env pair.
 *
 * `authProvider` is the session-scoped OAuth client provider and is attached
 * ONLY to Streamable HTTP transports. stdio and SSE transports never receive
 * it, so their behavior is unchanged. In-memory test factories may ignore it.
 */
export interface MCPTransportFactoryOptions {
	authProvider?: OAuthClientProvider;
}

/**
 * Creates the SDK transport for a server config.
 *
 * Production uses {@link createMCPDefaultTransport}. Tests inject a factory that
 * returns in-memory or mock transports so the same lifecycle contract is
 * exercised for both stdio and Streamable HTTP without real processes or
 * network connections.
 */
export type MCPTransportFactory = (
	config: MCPServerConfig,
	env: MCPEnvResolver,
	options?: MCPTransportFactoryOptions,
) => Promise<Transport> | Transport;

/**
 * Classified lifecycle failures. Messages are fail-closed: they never contain
 * command arguments, cwd, environment values, header values, tokens, auth
 * values, raw remote error text, or unredacted URLs. The raw remote error is
 * never retained on the error object, so it cannot surface through JSON
 * serialization or Node's error inspection.
 */
export type MCPErrorKind =
	| "not_selected"
	| "invalid_config"
	| "connect_failed"
	| "auth_required"
	| "unavailable"
	| "call_failed"
	| "content_invalid"
	| "content_limit_exceeded";

/** A redacted, serializable view of an MCP lifecycle failure. */
export interface MCPErrorView {
	kind: MCPErrorKind;
	serverId: string;
	message: string;
	/** Canonical capability error code this failure maps to. */
	code: CapabilityErrorCode;
}

/** Maps a lifecycle failure kind to the canonical capability error code. */
export function mcpErrorKindToCapabilityCode(kind: MCPErrorKind): CapabilityErrorCode {
	switch (kind) {
		case "not_selected":
		case "invalid_config":
			return "capability_denied";
		case "connect_failed":
			return "capability_mcp_connect_failed";
		case "auth_required":
			return "capability_mcp_auth_required";
		case "unavailable":
		case "call_failed":
		case "content_invalid":
		case "content_limit_exceeded":
			return "capability_mcp_unavailable";
	}
}

/**
 * Lifecycle failure with a safe, redacted message.
 *
 * The `message` is always constructed by the lifecycle from a fixed template,
 * so remote errors can never leak their text into logs, RPC output, or status.
 * A raw remote error is never accepted or stored: callers that need deeper
 * diagnostics must keep the original error at their own call site.
 */
export class MCPError extends Error {
	readonly kind: MCPErrorKind;
	readonly serverId: string;
	readonly code: CapabilityErrorCode;

	constructor(kind: MCPErrorKind, serverId: string, message: string) {
		super(message);
		this.name = "MCPError";
		this.kind = kind;
		this.serverId = serverId;
		this.code = mcpErrorKindToCapabilityCode(kind);
	}

	toJSON(): MCPErrorView {
		return {
			kind: this.kind,
			serverId: this.serverId,
			message: this.message,
			code: this.code,
		};
	}
}

/** Connection status surfaced to callers. Contains no secrets. */
export interface MCPConnectionStatus {
	serverId: string;
	state: MCPConnectionState;
	/** Registry-facing availability derived from the current state. */
	availability: CapabilityAvailability;
	/** ISO timestamp when the connection reached `ready`. */
	connectedAt?: string;
	/** Redacted failure recorded after a connect/list/call failure. */
	lastError?: MCPErrorView;
	/** Number of tools discovered by the last successful listTools. */
	toolCount?: number;
	/** Number of resources returned by the last successful listResources page. */
	resourceCount?: number;
	/** Number of prompts returned by the last successful listPrompts page. */
	promptCount?: number;
}

/**
 * Maps a lifecycle state to the registry-facing availability.
 *
 * Only a fully ready connection is `available`; a degraded connection is
 * `degraded`; configured/connecting/closing/closed/unavailable are
 * `unavailable`. A degraded or unavailable server's capabilities must never be
 * treated as available.
 */
export function mcpStateToAvailability(state: MCPConnectionState): CapabilityAvailability {
	switch (state) {
		case "ready":
			return "available";
		case "degraded":
			return "degraded";
		case "configured":
		case "connecting":
		case "unavailable":
		case "closing":
		case "closed":
			return "unavailable";
	}
}

const MCP_NAMESPACE_INVALID = /[\s:]/;

/**
 * Validates a single namespace segment used in `mcp__<serverId>__<toolName>`.
 *
 * Rejects empty segments and segments containing a double underscore (which
 * would make the namespaced name ambiguous), whitespace, control characters,
 * or a colon (which is the capability-id separator).
 */
export function isValidMCPNamespaceSegment(segment: string): boolean {
	return segment.length > 0 && !segment.includes("__") && !MCP_NAMESPACE_INVALID.test(segment);
}

/** Returns a fail-closed reason when a segment is invalid, or undefined when valid. */
export function mcpNamespaceSegmentError(segment: string): string | undefined {
	if (segment.length === 0) {
		return "must not be empty";
	}
	if (segment.includes("__")) {
		return "must not contain a double underscore";
	}
	if (MCP_NAMESPACE_INVALID.test(segment)) {
		return "must not contain whitespace or ':'";
	}
	return undefined;
}

/**
 * Redacts a URL for public display: strips userinfo, query, and fragment.
 * Returns a placeholder when the URL cannot be parsed, never the raw input.
 */
export function redactMCPUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "<invalid-url>";
	}
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

/**
 * Public, fail-closed view of a server config.
 *
 * Never includes command arguments, cwd, environment values, header values,
 * tokens, or unredacted URLs. Only environment variable NAMES and header NAMES
 * are exposed, together with the executable name and the redacted endpoint.
 */
export interface MCPServerConfigView {
	id: string;
	transport: MCPTransportType;
	/** stdio: executable name only. */
	command?: string;
	/** Environment variable names referenced by this config (stdio or headers). */
	envNames?: ReadonlyArray<string>;
	/** streamable-http: redacted endpoint URL. */
	url?: string;
	/** streamable-http: header names only. */
	headerNames?: ReadonlyArray<string>;
}

export function createMCPServerConfigView(config: MCPServerConfig): MCPServerConfigView {
	switch (config.transport) {
		case "stdio":
			return {
				id: config.id,
				transport: config.transport,
				command: config.command,
				...(config.env !== undefined ? { envNames: [...config.env] } : {}),
			};
		case "streamable-http": {
			const headers = config.headersFromEnv ?? [];
			return {
				id: config.id,
				transport: config.transport,
				url: redactMCPUrl(config.url),
				...(headers.length > 0 ? { headerNames: headers.map((header) => header.name) } : {}),
				...(headers.length > 0
					? { envNames: headers.map((header) => header.valueFromEnv) }
					: {}),
			};
		}
	}
}

const MCP_CREDENTIAL_QUERY_PATTERN = /key|token|api[_-]?key|secret|passwd|password|auth|sig|credential/i;

/**
 * Validates a server config before connection. Fail-closed: rejects invalid
 * server id namespaces, empty stdio commands, unparseable HTTP URLs, HTTP URLs
 * with userinfo, and HTTP URLs whose query carries credential-like keys.
 */
export function validateMCPServerConfig(config: MCPServerConfig): ReadonlyArray<string> {
	const problems: string[] = [];
	const idError = mcpNamespaceSegmentError(config.id);
	if (idError !== undefined) {
		problems.push(`server id ${idError}`);
	}
	switch (config.transport) {
		case "stdio":
			if (config.command.trim().length === 0) {
				problems.push("stdio command must not be empty");
			}
			break;
		case "streamable-http": {
			let parsed: URL;
			try {
				parsed = new URL(config.url);
			} catch {
				problems.push("url is not a valid URL");
				break;
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				problems.push("url must use http or https");
			}
			if (parsed.hostname.length === 0) {
				problems.push("url must have a host");
			}
			if (parsed.username !== "" || parsed.password !== "") {
				problems.push("url must not contain userinfo");
			}
			if ([...parsed.searchParams.keys()].some((key) => MCP_CREDENTIAL_QUERY_PATTERN.test(key))) {
				problems.push("url query must not contain credentials");
			}
			break;
		}
	}
	return problems;
}
