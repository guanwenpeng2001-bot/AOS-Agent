/**
 * MCP error-code mapping to the PR error contract (section 8).
 *
 * The Automation Host wire carries the stable PR codes
 * (`mcp_auth_metadata_invalid`, `mcp_auth_invalid`, `mcp_content_invalid`,
 * `mcp_content_limit_exceeded`, `mcp_resource_denied`, `mcp_prompt_denied`,
 * ...). The internal core classification stays fine-grained
 * ({@link MCPAuthErrorKind}, {@link MCPContentErrorCode}); this module is the
 * single mapping point from the core kinds to the public codes. Messages are
 * fixed templates; raw remote text, tokens, URLs, and raw URIs never surface.
 */

import type { MCPAuthErrorKind } from "./mcp-auth.ts";
import type { MCPContentErrorCode } from "./mcp-content.ts";

/** Public MCP OAuth error codes of the PR contract. */
export type MCPAuthPublicErrorCode =
	| "mcp_auth_metadata_invalid"
	| "mcp_auth_resource_mismatch"
	| "mcp_auth_state_mismatch"
	| "mcp_auth_invalid"
	| "mcp_auth_cancelled";

/**
 * Maps a classified OAuth flow failure to its PR contract code.
 *
 * - metadata validation failures (endpoint shape, discovery, issuer,
 *   unsupported flow) -> `mcp_auth_metadata_invalid`;
 * - resource indicator mismatch -> `mcp_auth_resource_mismatch`;
 * - callback state mismatch -> `mcp_auth_state_mismatch`;
 * - invalid/expired token, refresh, or authorization code -> `mcp_auth_invalid`;
 * - user cancel and callback timeout -> `mcp_auth_cancelled`.
 */
export function mcpAuthErrorPublicCode(kind: MCPAuthErrorKind): MCPAuthPublicErrorCode {
	switch (kind) {
		case "invalid_server_url":
		case "insecure_endpoint":
		case "invalid_callback_url":
		case "discovery_failed":
		case "issuer_mismatch":
		case "unsupported":
			return "mcp_auth_metadata_invalid";
		case "resource_mismatch":
			return "mcp_auth_resource_mismatch";
		case "state_mismatch":
			return "mcp_auth_state_mismatch";
		case "user_cancelled":
		case "callback_timeout":
			return "mcp_auth_cancelled";
		case "auth_failed":
		case "flow_used":
			return "mcp_auth_invalid";
	}
}

/** Public MCP content error codes of the PR contract. */
export type MCPContentPublicErrorCode =
	| "mcp_content_invalid"
	| "mcp_content_limit_exceeded"
	| "mcp_resource_unavailable"
	| "mcp_prompt_unavailable";

/**
 * Maps a fine-grained content-safety failure to its PR contract code.
 *
 * - size/count limit violations -> `mcp_content_limit_exceeded`;
 * - malformed, unsupported, encoding, and MIME contract violations ->
 *   `mcp_content_invalid`;
 * - unsupported server capabilities keep their operation-specific codes.
 */
export function mcpContentErrorPublicCode(code: MCPContentErrorCode): MCPContentPublicErrorCode {
	switch (code) {
		case "mcp_content_oversize":
			return "mcp_content_limit_exceeded";
		case "mcp_content_malformed":
		case "mcp_content_unsupported":
		case "mcp_content_encoding":
		case "mcp_content_mime":
			return "mcp_content_invalid";
		case "mcp_resource_unavailable":
			return "mcp_resource_unavailable";
		case "mcp_prompt_unavailable":
			return "mcp_prompt_unavailable";
	}
}
