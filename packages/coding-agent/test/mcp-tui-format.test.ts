import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityError } from "../src/core/capability-registry.ts";
import { MCPAuthError } from "../src/core/mcp-auth.ts";
import { MCPError } from "../src/core/mcp-types.ts";
import {
	formatMcpAttachment,
	formatMcpAuthResult,
	formatMcpAuthStatusView,
	formatMcpError,
	formatMcpPromptPreview,
	formatMcpPrompts,
	formatMcpResourcePreview,
	formatMcpResources,
	formatMcpServerList,
	formatMcpUntrustedBanner,
	formatMcpUsage,
	parseMcpPromptArgs,
} from "../src/modes/interactive/mcp.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

beforeEach(() => {
	initTheme("dark");
});

describe("interactive /mcp formatting", () => {
	it("renders usage for all six subcommands", () => {
		const usage = stripAnsi(formatMcpUsage());
		expect(usage).toContain("/mcp auth <serverId>");
		expect(usage).toContain("/mcp logout <serverId>");
		expect(usage).toContain("/mcp resources [serverId]");
		expect(usage).toContain("/mcp resource [serverId] <resourceId>");
		expect(usage).toContain("/mcp prompts [serverId]");
		expect(usage).toContain("/mcp prompt [serverId] <promptId> [key=value ...]");
	});

	it("formats the server list without leaking config details", () => {
		expect(stripAnsi(formatMcpServerList(["docs", "search"]))).toBe("Configured MCP servers: docs, search");
		expect(stripAnsi(formatMcpServerList([]))).toBe("No MCP servers are configured.");
	});

	it("renders auth status redacted: state and credential status only", () => {
		const view = {
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "authenticated", expiresAt: "2026-08-17T00:00:00.000Z" },
			credential: {
				serverId: "docs",
				hasCredential: true,
				status: "authenticated",
				expiresAt: 1784332800000,
				scopes: ["read", "resources"],
				revision: 3,
			},
		} as const;
		const out = stripAnsi(formatMcpAuthStatusView(view));
		expect(out).toContain("MCP auth status: docs");
		expect(out).toContain("flow state: authenticated");
		expect(out).toContain("stored credential: authenticated");
		expect(out).toContain("scopes: read,resources");
		// Never tokens, authorization URLs, issuer, or resource values.
		expect(out).not.toContain("token");
		expect(out).not.toContain("://");
		expect(out).not.toContain("issuer");
		expect(out).not.toContain("canonical");
	});

	it("renders auth results without echoing the authorization URL", () => {
		const authorized = stripAnsi(formatMcpAuthResult({ outcome: "authorized", status: { serverId: "docs", state: "authenticated" } }));
		expect(authorized).toContain("MCP OAuth authorized.");
		expect(authorized).not.toContain("http");

		expect(stripAnsi(formatMcpAuthResult({ outcome: "cancelled", status: { serverId: "docs", state: "unauthenticated" } }))).toContain(
			"MCP OAuth cancelled.",
		);
		expect(stripAnsi(formatMcpAuthResult({ outcome: "timeout", status: { serverId: "docs", state: "unauthenticated" } }))).toContain(
			"timed out",
		);
		const interactionRequired = stripAnsi(
			formatMcpAuthResult({
				outcome: "interaction_required",
				status: { serverId: "docs", state: "interaction_required" },
				authorizationUrl: "https://auth.example.invalid/authorize?secret=1",
			}),
		);
		expect(interactionRequired).toContain("shown once");
		expect(interactionRequired).not.toContain("auth.example.invalid");
	});

	it("lists resources with metadata and a read hint", () => {
		const page = {
			items: [
				{
					serverId: "docs",
					resourceId: "mcp-res-1111111111111111",
					name: "spec",
					description: "The spec",
					mimeType: "text/markdown",
					size: 42,
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		};
		const templates = {
			items: [
				{
					serverId: "docs",
					templateId: "mcp-tpl-1111111111111111",
					name: "item",
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		};
		const out = stripAnsi(formatMcpResources("docs", page, templates));
		expect(out).toContain("MCP resources: docs");
		expect(out).toContain("spec");
		expect(out).toContain("mcp-res-1111111111111111");
		expect(out).toContain("mcp-tpl-1111111111111111");
		expect(out).toContain("/mcp resource [serverId] <resourceId>");
	});

	it("previews resources behind the untrusted banner and caps the text", () => {
		const longText = "x".repeat(5_000);
		const result = {
			serverId: "docs",
			resourceId: "mcp-res-1111111111111111",
			content: {
				blocks: [{ type: "text" as const, text: longText }],
				truncated: true,
				unsafe: false,
				droppedBlocks: 1,
				droppedBytes: 0,
				byteCount: longText.length,
			},
			byteCount: longText.length,
			truncated: true,
			provenanceId: "mcp-content-1111111111111111",
			revision: "rev:1111111111111111",
		};
		const out = stripAnsi(formatMcpResourcePreview("docs", result));
		expect(out).toContain("UNTRUSTED EXTERNAL MCP CONTENT");
		expect(out).toContain("untrusted input");
		expect(out).toContain("preview truncated");
		// The preview itself is bounded.
		expect(out.length).toBeLessThan(3_000);
	});

	it("lists prompts with declared arguments", () => {
		const page = {
			items: [
				{
					serverId: "docs",
					promptId: "mcp-prompt-1111111111111111",
					name: "summarize",
					description: "Summarize a resource",
					arguments: [{ name: "uri", required: true }],
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		};
		const out = stripAnsi(formatMcpPrompts("docs", page));
		expect(out).toContain("MCP prompts: docs");
		expect(out).toContain("summarize");
		expect(out).toContain("arguments: uri*");
		expect(out).toContain("/mcp prompt [serverId] <promptId>");
	});

	it("previews prompt messages preserving roles and the untrusted banner", () => {
		const result = {
			serverId: "docs",
			promptId: "mcp-prompt-1111111111111111",
			description: "Summarize a resource",
			messages: [
				{ role: "user" as const, content: { blocks: [{ type: "text" as const, text: "Summarize this" }], truncated: false, unsafe: false, droppedBlocks: 0, droppedBytes: 0, byteCount: 14 } },
				{ role: "assistant" as const, content: { blocks: [{ type: "text" as const, text: "Here is the summary" }], truncated: false, unsafe: false, droppedBlocks: 0, droppedBytes: 0, byteCount: 19 } },
			],
			provenanceId: "mcp-content-1111111111111111",
			revision: "rev:1111111111111111",
		};
		const out = stripAnsi(formatMcpPromptPreview("docs", result));
		expect(out).toContain(stripAnsi(formatMcpUntrustedBanner()));
		expect(out).toContain("[user]");
		expect(out).toContain("[assistant]");
		expect(out).toContain("never system/developer instructions");
	});

	it("renders attachment receipts without echoing content", () => {
		const out = stripAnsi(
			formatMcpAttachment({ attachmentId: "src-1", serverId: "docs", contentLength: 12, truncated: false }),
		);
		expect(out).toContain("MCP content attached for the next turn");
		expect(out).toContain("src-1");
		expect(out).toContain("chars: 12");
		expect(out).not.toContain("secret body text");
	});

	it("formats errors as fixed redacted templates only", () => {
		const authError = new MCPAuthError("mcp_auth_cancelled", "docs");
		const authOut = stripAnsi(formatMcpError(authError));
		expect(authOut).toContain("mcp_auth_cancelled");
		expect(authOut).toContain("cancelled");

		const mcpError = new MCPError("unavailable", "docs", "remote server exploded with token=abc");
		const mcpOut = stripAnsi(formatMcpError(mcpError));
		expect(mcpOut).toContain("unavailable");
		expect(mcpOut).toContain("MCP server is unavailable");
		expect(mcpOut).not.toContain("token=abc");
		expect(mcpOut).not.toContain("exploded");

		const capabilityError = new CapabilityError("capability_denied", `MCP server "docs" is denied`);
		const capabilityOut = stripAnsi(formatMcpError(capabilityError));
		expect(capabilityOut).toContain("capability_denied");
		expect(capabilityOut).toContain("denied");

		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(stripAnsi(formatMcpError(abort))).toContain("cancelled");

		// Unknown errors never echo their raw message.
		const unknown = formatMcpError(new Error("raw remote error with super-secret value"));
		expect(stripAnsi(unknown)).toBe("MCP command failed.");
	});

	it("parses key=value prompt arguments and rejects malformed ones", () => {
		expect(parseMcpPromptArgs(["uri=docs://a", "level=deep"])).toEqual({ values: { uri: "docs://a", level: "deep" } });
		expect(parseMcpPromptArgs([])).toEqual({ values: {} });
		const malformed = parseMcpPromptArgs(["noEquals"]);
		expect(malformed.error).toContain("expected key=value");
		expect(parseMcpPromptArgs(["=empty"])).toBeTruthy();
	});
});
