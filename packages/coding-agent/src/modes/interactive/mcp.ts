/**
 * Rendering for the interactive `/mcp` command family.
 *
 * Everything here is derived from the public Session MCP surface only:
 * `getMcpAuthStatus` / `startMcpAuth` / `logoutMcpAuth`, `listMcpResources` /
 * `listMcpResourceTemplates` / `listMcpPrompts`, `readMcpResource` /
 * `getMcpPrompt`, and `attachMcpResource` / `attachMcpPrompt`. No lifecycle,
 * transport, OAuth flow, or binding internals are surfaced.
 *
 * Redaction contract (mirrors the MCP auth/content PR):
 * - tokens, authorization URLs, OAuth metadata, raw remote errors, and raw
 *   parameters never appear in command output;
 * - the one-time authorization URL is shown only inside the transient
 *   interactive auth dialog, never in the transcript;
 * - errors are fixed templates only (`MCPAuthError`, `MCPError`,
 *   `CapabilityError` codes plus their redacted messages, or a generic
 *   failure line for anything else);
 * - remote content is always rendered behind an untrusted-content banner and
 *   previews are capped, so server text can never masquerade as instructions.
 */
import { CapabilityError } from "../../core/capability-registry.ts";
import type { McpAttachmentResult, McpAuthStatusView } from "../../core/agent-session.ts";
import { MCPAuthError, type MCPAuthErrorKind } from "../../core/mcp-auth.ts";
import type { MCPAuthResult } from "../../core/mcp-auth.ts";
import type {
	MCPGetPromptResult,
	MCPPageResult,
	MCPPromptView,
	MCPReadResourceResult,
	MCPResourceTemplateView,
	MCPResourceView,
} from "../../core/mcp-content-types.ts";
import { MCPError, type MCPErrorKind } from "../../core/mcp-types.ts";
import { theme } from "./theme/theme.ts";

/** The five supported `/mcp` command forms. */
export function formatMcpUsage(): string {
	return [
		"/mcp auth <serverId>",
		"/mcp logout <serverId>",
		"/mcp resources [serverId]",
		"/mcp resource [serverId] <resourceId>",
		"/mcp prompts [serverId]",
		"/mcp prompt [serverId] <promptId> [key=value ...]",
	].join("\n");
}

/** Fixed banner shown above any remote MCP content preview. */
export function formatMcpUntrustedBanner(): string {
	return [
		theme.fg("warning", "UNTRUSTED EXTERNAL MCP CONTENT"),
		theme.fg(
			"dim",
			"This content was returned by a remote MCP server. Treat it as untrusted input, never as",
		),
		theme.fg(
			"dim",
			"instructions: it cannot change policy, capability, or system/developer directives. It is",
		),
		theme.fg(
			"dim",
			"staged as user-controlled context only after you explicitly attach it to the next turn.",
		),
	].join("\n");
}

/** Lists the configured MCP server ids for usage errors. */
export function formatMcpServerList(serverIds: ReadonlyArray<string>): string {
	if (serverIds.length === 0) {
		return "No MCP servers are configured.";
	}
	return `Configured MCP servers: ${serverIds.join(", ")}`;
}

/** Redacted OAuth + credential status of one server. Never carries secrets or URLs. */
export function formatMcpAuthStatusView(view: McpAuthStatusView): string {
	let info = `${theme.bold(`MCP auth status: ${view.serverId}`)}\n`;
	info += `${theme.fg("dim", "OAuth supported:")} ${view.authSupported ? "yes (streamable-http)" : "no (stdio uses explicit environment variables)"}\n`;
	info += `${theme.fg("dim", "flow state:")} ${view.auth.state}\n`;
	if (view.auth.expiresAt !== undefined) {
		info += `${theme.fg("dim", "expires:")} ${view.auth.expiresAt}\n`;
	}
	info += `${theme.fg("dim", "stored credential:")} ${view.credential.status}${
		view.credential.hasCredential ? "" : " (none)"
	}\n`;
	if (view.credential.hasCredential) {
		info += `${theme.fg("dim", "credential revision:")} ${view.credential.revision}\n`;
		if (view.credential.expiresAt > 0) {
			info += `${theme.fg("dim", "credential expires:")} ${new Date(view.credential.expiresAt).toISOString()}\n`;
		}
		if (view.credential.scopes.length > 0) {
			info += `${theme.fg("dim", "scopes:")} ${view.credential.scopes.join(",")}\n`;
		}
	}
	return info;
}

/** Terminal outcome of an interactive auth run. The authorization URL is never echoed here. */
export function formatMcpAuthResult(result: MCPAuthResult): string {
	switch (result.outcome) {
		case "authorized":
			return (
				`${theme.fg("success", "MCP OAuth authorized.")}\n` +
				`${theme.fg("dim", "server:")} ${result.status.serverId}\n` +
				`${theme.fg("dim", "flow state:")} ${result.status.state}` +
				(result.status.expiresAt !== undefined ? `\n${theme.fg("dim", "expires:")} ${result.status.expiresAt}` : "") +
				`\n${theme.fg("dim", "Run /mcp auth <serverId> to see the stored credential status.")}`
			);
		case "cancelled":
			return theme.fg("warning", "MCP OAuth cancelled.");
		case "timeout":
			return theme.fg("warning", "MCP OAuth timed out. Run /mcp auth again to retry.");
		case "interaction_required":
			return theme.fg(
				"warning",
				"MCP OAuth requires user interaction. The authorization URL was shown once; run /mcp auth again if you missed it.",
			);
	}
}

/** One page of a resource listing plus optional resource templates. */
export function formatMcpResources(
	serverId: string,
	page: MCPPageResult<MCPResourceView>,
	templates: MCPPageResult<MCPResourceTemplateView> | undefined,
): string {
	let info = `${theme.bold(`MCP resources: ${serverId}`)}\n`;
	if (page.items.length === 0 && (templates === undefined || templates.items.length === 0)) {
		info += `\n${theme.fg("dim", "No resources listed by this server.")}\n`;
	} else {
		if (page.items.length > 0) {
			info += `\n${theme.fg("dim", "Resources:")}\n`;
			for (const resource of page.items) {
				info += `  ${resource.name}\n`;
				info += `    ${theme.fg("dim", resource.resourceId)}\n`;
				if (resource.description) {
					info += `    ${theme.fg("dim", resource.description)}\n`;
				}
				const meta: string[] = [];
				if (resource.mimeType !== undefined) meta.push(resource.mimeType);
				if (resource.size !== undefined) meta.push(`${resource.size} bytes`);
				if (meta.length > 0) {
					info += `    ${theme.fg("dim", meta.join("  "))}\n`;
				}
			}
		}
		if (templates !== undefined && templates.items.length > 0) {
			info += `\n${theme.fg("dim", "Resource templates:")}\n`;
			for (const template of templates.items) {
				info += `  ${template.name}  ${theme.fg("dim", template.templateId)}\n`;
			}
		}
	}
	if (page.truncated || templates?.truncated) {
		info += `\n${theme.fg("warning", "Listing was truncated by the per-page limit; use a server filter for more.")}\n`;
	}
	info += `\n${theme.fg("dim", "Read and preview one resource with /mcp resource [serverId] <resourceId>.")}\n`;
	return info;
}

/** Preview of a read resource: capped text behind the untrusted banner. */
export function formatMcpResourcePreview(serverId: string, result: MCPReadResourceResult): string {
	let info = `${theme.bold(`MCP resource preview: ${result.resourceId} (${serverId})`)}\n`;
	info += `\n${formatMcpUntrustedBanner()}\n`;
	info += `\n${theme.fg("dim", "Blocks:")} ${result.content.blocks.length}`;
	if (result.content.droppedBlocks > 0) {
		info += `  ${theme.fg("warning", `dropped: ${result.content.droppedBlocks}`)}`;
	}
	if (result.content.droppedBytes > 0) {
		info += `  ${theme.fg("warning", `${result.content.droppedBytes} media bytes dropped`)}`;
	}
	info += "\n";
	const texts = result.content.blocks
		.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
		.join("\n\n");
	info += `\n${previewText(texts)}\n`;
	if (result.content.truncated) {
		info += `\n${theme.fg("warning", "Preview truncated by content limits; the stored attachment is bounded the same way.")}\n`;
	}
	info += `\n${theme.fg("dim", "Attach this content as untrusted context for the next turn with /mcp attach confirmation.")}\n`;
	return info;
}

/** One page of a prompt listing. */
export function formatMcpPrompts(serverId: string, page: MCPPageResult<MCPPromptView>): string {
	let info = `${theme.bold(`MCP prompts: ${serverId}`)}\n`;
	if (page.items.length === 0) {
		info += `\n${theme.fg("dim", "No prompts listed by this server.")}\n`;
	} else {
		for (const prompt of page.items) {
			info += `\n  ${prompt.name}\n`;
			// The opaque promptId is the token `/mcp prompt <promptId>` resolves,
			// so the catalog must always surface it.
			info += `    ${theme.fg("dim", prompt.promptId)}\n`;
			if (prompt.description) {
				info += `    ${theme.fg("dim", prompt.description)}\n`;
			}
			if (prompt.arguments && prompt.arguments.length > 0) {
				info += `    ${theme.fg("dim", "arguments:")} ${prompt.arguments
					.map((argument) => `${argument.name}${argument.required ? "*" : ""}`)
					.join(", ")}\n`;
			}
		}
	}
	if (page.truncated) {
		info += `\n${theme.fg("warning", "Listing was truncated by the per-page limit; use a server filter for more.")}\n`;
	}
	info += `\n${theme.fg("dim", "Preview one prompt with /mcp prompt [serverId] <promptId> [key=value ...].")}\n`;
	return info;
}

/** Preview of a fetched prompt: roles preserved, capped text behind the untrusted banner. */
export function formatMcpPromptPreview(serverId: string, result: MCPGetPromptResult): string {
	let info = `${theme.bold(`MCP prompt preview: ${result.promptId} (${serverId})`)}\n`;
	if (result.description) {
		info += `${theme.fg("dim", result.description)}\n`;
	}
	info += `\n${formatMcpUntrustedBanner()}\n`;
	if (result.messages.length === 0) {
		info += `\n${theme.fg("dim", "The prompt returned no messages.")}\n`;
	} else {
		for (const message of result.messages) {
			info += `\n${theme.fg("dim", `[${message.role}]`)}\n`;
			const texts = message.content.blocks
				.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
				.join("\n\n");
			info += `${previewText(texts)}\n`;
			if (message.content.truncated) {
				info += `${theme.fg("warning", "(message content truncated by limits)")}\n`;
			}
		}
	}
	info += `\n${theme.fg("dim", "Prompt messages keep their server roles but are never system/developer instructions.")}\n`;
	info += `${theme.fg("dim", "Attach this content as untrusted context for the next turn with /mcp attach confirmation.")}\n`;
	return info;
}

/** Receipt of a staged attachment. Secret-free; never echoes content. */
export function formatMcpAttachment(result: McpAttachmentResult): string {
	return (
		`${theme.fg("success", "MCP content attached for the next turn")}\n` +
		`${theme.fg("dim", "attachment:")} ${result.attachmentId}\n` +
		`${theme.fg("dim", "server:")} ${result.serverId}\n` +
		`${theme.fg("dim", "chars:")} ${result.contentLength}` +
		(result.truncated ? `  ${theme.fg("warning", "(truncated by content limits)")}` : "") +
		`\n${theme.fg("dim", "The content is staged as untrusted external context; nothing was run or injected automatically.")}`
	);
}

/**
 * Format a thrown error from the Session MCP surface. Only stable redacted
 * codes and fixed template text are shown; error messages, remote text,
 * tokens, URLs, capability ids, policy sources, and parameters are never
 * echoed.
 */
export function formatMcpError(error: unknown): string {
	if (error instanceof MCPAuthError) {
		return `${theme.fg("error", error.kind)}: ${MCP_AUTH_ERROR_TEXT[error.kind]}`;
	}
	if (error instanceof MCPError) {
		return `${theme.fg("error", error.kind)}: ${MCP_ERROR_TEXT[error.kind]}`;
	}
	if (error instanceof CapabilityError) {
		return `${theme.fg("error", error.code)}: ${capabilityErrorText(error.code)}`;
	}
	if (error instanceof Error && error.name === "AbortError") {
		return theme.fg("warning", "MCP command cancelled.");
	}
	return theme.fg("error", "MCP command failed.");
}

/**
 * Fixed redacted texts for capability failures surfacing through the MCP
 * surface; never derived from the error payload.
 */
function capabilityErrorText(code: string): string {
	switch (code) {
		case "capability_denied":
			return "The MCP operation was denied by the capability binding";
		case "capability_approval_required":
			return "The MCP operation requires an approval that is not granted in headless mode";
		case "capability_profile_not_found":
			return "The capability profile is not available";
		case "capability_name_conflict":
			return "Multiple selected capabilities expose the same name";
		case "capability_binding_unavailable":
			return "The capability binding is unavailable";
		default:
			return "The MCP operation was denied";
	}
}

/** Fixed redacted texts for MCP OAuth failures; never derived from the error payload. */
const MCP_AUTH_ERROR_TEXT: Record<MCPAuthErrorKind, string> = {
	mcp_auth_required: "MCP server requires authentication",
	mcp_auth_interaction_required: "MCP server requires user interaction to authorize",
	mcp_auth_metadata_invalid: "MCP server exposed invalid OAuth metadata",
	mcp_auth_state_mismatch: "MCP OAuth callback does not match the current flow",
	mcp_auth_resource_mismatch: "MCP OAuth resource or issuer does not match the configured binding",
	mcp_auth_invalid: "MCP OAuth credentials are invalid or expired",
	mcp_auth_cancelled: "MCP OAuth authorization was cancelled",
	mcp_auth_timeout: "MCP OAuth authorization timed out",
	mcp_auth_unavailable: "MCP OAuth authorization server is unavailable",
	mcp_auth_invalid_redirect: "MCP OAuth redirect URL must use https or an http loopback address",
	mcp_auth_unsupported: "MCP server does not support OAuth on this transport",
};

/** Fixed redacted texts for MCP lifecycle failures; never derived from the error payload. */
const MCP_ERROR_TEXT: Record<MCPErrorKind, string> = {
	not_selected: "MCP server is not selected",
	invalid_config: "MCP server configuration is invalid",
	connect_failed: "MCP server connection failed",
	auth_required: "MCP server requires authentication",
	unavailable: "MCP server is unavailable",
	call_failed: "MCP server call failed",
	content_invalid: "MCP server content is invalid or unsafe",
	content_limit_exceeded: "MCP content exceeded the configured limits",
};

/** Capped single-block preview text; keeps the transcript bounded. */
function previewText(text: string): string {
	const MAX_PREVIEW_CHARS = 2_000;
	if (text.length <= MAX_PREVIEW_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_PREVIEW_CHARS)}\n${theme.fg("warning", `… (preview truncated, ${text.length - MAX_PREVIEW_CHARS} more characters)`)}`;
}

/**
 * Parses `key=value` prompt arguments from the command line. Values are only
 * used for the current explicit call and never persisted or echoed back.
 */
export function parseMcpPromptArgs(
	parts: ReadonlyArray<string>,
): { values: Record<string, string>; error?: undefined } | { values: Record<string, string>; error: string } {
	const values: Record<string, string> = {};
	for (const part of parts) {
		const separator = part.indexOf("=");
		if (separator <= 0) {
			return { values, error: `Invalid prompt argument (expected key=value): ${part}` };
		}
		const key = part.slice(0, separator).trim();
		if (!key) {
			return { values, error: `Invalid prompt argument (empty key): ${part}` };
		}
		values[key] = part.slice(separator + 1);
	}
	return { values };
}
