import { describe, expect, it } from "vitest";
import { mcpAuthErrorPublicCode, mcpContentErrorPublicCode } from "../src/core/runtime/mcp-error-codes.ts";

/**
 * PR error contract (section 8): the Automation Host wire carries the stable
 * mcp_* codes. Internal fine-grained classification stays in the core; these
 * tests prove every PR code is reachable through the public mapper.
 */
describe("mcpAuthErrorPublicCode (PR error contract)", () => {
	it("maps metadata validation failures to mcp_auth_metadata_invalid", () => {
		for (const kind of [
			"invalid_server_url",
			"insecure_endpoint",
			"invalid_callback_url",
			"discovery_failed",
			"issuer_mismatch",
			"unsupported",
		] as const) {
			expect(mcpAuthErrorPublicCode(kind)).toBe("mcp_auth_metadata_invalid");
		}
	});

	it("maps resource indicator mismatch to mcp_auth_resource_mismatch", () => {
		expect(mcpAuthErrorPublicCode("resource_mismatch")).toBe("mcp_auth_resource_mismatch");
	});

	it("maps callback state mismatch to mcp_auth_state_mismatch", () => {
		expect(mcpAuthErrorPublicCode("state_mismatch")).toBe("mcp_auth_state_mismatch");
	});

	it("maps user cancel and callback timeout to mcp_auth_cancelled", () => {
		for (const kind of ["user_cancelled", "callback_timeout"] as const) {
			expect(mcpAuthErrorPublicCode(kind)).toBe("mcp_auth_cancelled");
		}
	});

	it("maps invalid/expired token, refresh, and authorization code failures to mcp_auth_invalid", () => {
		for (const kind of ["auth_failed", "flow_used"] as const) {
			expect(mcpAuthErrorPublicCode(kind)).toBe("mcp_auth_invalid");
		}
	});
});

describe("mcpContentErrorPublicCode (PR error contract)", () => {
	it("maps size/count limit violations to mcp_content_limit_exceeded", () => {
		expect(mcpContentErrorPublicCode("mcp_content_oversize")).toBe("mcp_content_limit_exceeded");
	});

	it("maps structural content violations to mcp_content_invalid", () => {
		for (const code of ["mcp_content_malformed", "mcp_content_unsupported", "mcp_content_encoding", "mcp_content_mime"] as const) {
			expect(mcpContentErrorPublicCode(code)).toBe("mcp_content_invalid");
		}
	});

	it("keeps the operation-specific unavailable codes", () => {
		expect(mcpContentErrorPublicCode("mcp_resource_unavailable")).toBe("mcp_resource_unavailable");
		expect(mcpContentErrorPublicCode("mcp_prompt_unavailable")).toBe("mcp_prompt_unavailable");
	});
});
