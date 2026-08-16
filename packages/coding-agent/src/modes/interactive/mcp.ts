/**
 * Parsing and rendering for the interactive `/mcp` command.
 *
 * Everything here is derived from the public Session MCP surface
 * (`listMcpResources`, `readMcpResource`, `attachMcpResource`,
 * `listMcpPrompts`, `getMcpPrompt`, `attachMcpPrompt`, `getMcpConnectionStatus`,
 * `startMcpAuth`, `logoutMcpAuth`, `listMcpCredentialStatuses`) and the
 * redacted core views only. Output carries digest/metadata receipts with an
 * explicit untrusted/provenance label; tokens, URLs, raw URIs, prompt
 * argument values, and remote original text are never rendered here. Errors
 * are fixed safe templates or stable codes.
 */
import { CapabilityError } from "../../core/capability-registry.ts";
import { PolicyError } from "../../core/execution-policy.ts";
import { MCPAuthError } from "../../core/mcp-auth.ts";
import { MCPAuthStorageError } from "../../core/mcp-auth-storage.ts";
import type { McpAttachment } from "../../core/mcp-attachment.ts";
import { MCPContentError } from "../../core/mcp-content.ts";
import type { MCPGetPromptResult, MCPReadResourceResult } from "../../core/mcp-content.ts";
import { MCPError, type MCPConnectionStatus } from "../../core/mcp-types.ts";
import type { MCPPromptListResult, MCPResourceListResult } from "../../core/mcp-types.ts";
import { theme } from "./theme/theme.ts";

/** The supported `/mcp` subcommands. */
export type McpSubcommand = "auth" | "logout" | "resources" | "resource" | "prompts" | "prompt";

/** Parsed form of the `/mcp` argument string; never echoes raw values. */
export type ParsedMcpCommand =
	| { sub: undefined }
	| { sub: "auth"; serverId?: string }
	| { sub: "logout"; serverId?: string }
	| { sub: "resources"; serverId?: string; cursor?: string }
	| { sub: "prompts"; serverId?: string; cursor?: string }
	| { sub: "resource"; serverId: string; resourceId: string }
	| { sub: "prompt"; serverId: string; promptId: string; args: Record<string, string> };

export type McpParseResult = { ok: true; command: ParsedMcpCommand } | { ok: false; error: string };

/**
 * Parses the argument string of `/mcp`. Error texts are fixed templates:
 * prompt argument values and URIs are never echoed back.
 */
export function parseMcpCommandArgs(args: string): McpParseResult {
	const parts = args.split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return { ok: true, command: { sub: undefined } };
	}
	const sub = parts[0]!;
	switch (sub) {
		case "auth":
		case "logout": {
			if (parts.length > 2) {
				return { ok: false, error: "Too many arguments." };
			}
			return { ok: true, command: { sub, serverId: parts[1] } };
		}
		case "resources":
		case "prompts": {
			if (parts.length > 3) {
				return { ok: false, error: "Too many arguments." };
			}
			return { ok: true, command: { sub, serverId: parts[1], cursor: parts[2] } };
		}
		case "resource": {
			if (parts.length !== 3) {
				return { ok: false, error: "Usage: /mcp resource <server-id> <resourceId>" };
			}
			return { ok: true, command: { sub: "resource", serverId: parts[1]!, resourceId: parts[2]! } };
		}
		case "prompt": {
			if (parts.length < 3) {
				return { ok: false, error: "Usage: /mcp prompt <server-id> <promptId> [key=value ...]" };
			}
			const args: Record<string, string> = {};
			for (const part of parts.slice(3)) {
				const eq = part.indexOf("=");
				if (eq <= 0) {
					return { ok: false, error: "Invalid /mcp prompt arguments: expected key=value pairs." };
				}
				args[part.slice(0, eq)] = part.slice(eq + 1);
			}
			return { ok: true, command: { sub: "prompt", serverId: parts[1]!, promptId: parts[2]!, args } };
		}
		default:
			return { ok: false, error: `Unknown /mcp subcommand: ${sub}` };
	}
}

/** Local parse/usage failure with a fixed, safe message. */
export class McpCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpCommandError";
	}
}

/** The seven supported `/mcp` command forms. */
export function formatMcpUsage(): string {
	return [
		"Usage:",
		"  /mcp",
		"  /mcp auth <server-id>",
		"  /mcp logout <server-id>",
		"  /mcp resources <server-id> [cursor]",
		"  /mcp resource <server-id> <resourceId>",
		"  /mcp prompts <server-id> [cursor]",
		"  /mcp prompt <server-id> <promptId> [key=value ...]",
	].join("\n");
}

/** One row of the server overview; connection, trust, and masked auth facts only. */
export interface McpServerOverviewEntry {
	id: string;
	transport: string;
	trusted: boolean;
	connection?: MCPConnectionStatus;
	oauth: "authorized" | "none" | "not-applicable";
}

/** Renders the redacted server overview. Never contains URLs or tokens. */
export function formatMcpServersOverview(entries: ReadonlyArray<McpServerOverviewEntry>): string {
	const lines = [theme.bold(`MCP servers (${entries.length})`)];
	if (entries.length === 0) {
		lines.push(theme.fg("dim", "No MCP servers configured."));
	} else {
		for (const entry of entries) {
			const state = entry.connection?.state ?? "not-connected";
			const trust = entry.trusted ? "trusted" : theme.fg("warning", "untrusted");
			const oauth =
				entry.oauth === "authorized"
					? theme.fg("success", "oauth=authorized")
					: entry.oauth === "not-applicable"
						? theme.fg("dim", "oauth=n/a")
						: theme.fg("dim", "oauth=none");
			lines.push(`  ${entry.id.padEnd(18)} ${entry.transport.padEnd(15)} ${trust.padEnd(11)} ${state.padEnd(12)} ${oauth}`);
		}
	}
	lines.push(
		"",
		theme.fg(
			"dim",
			"Use /mcp auth <server-id> to authorize a Streamable HTTP server and /mcp logout <server-id> to remove its credential.",
		),
	);
	return lines.join("\n");
}

/** Renders one page of the resources catalog; digest metadata only. */
export function formatMcpResourceList(result: MCPResourceListResult): string {
	const lines = [
		theme.bold(`MCP resources: ${result.serverId}`),
		theme.fg("dim", "Untrusted catalog metadata; raw URIs are never shown."),
	];
	if (result.resources.length === 0) {
		lines.push(theme.fg("dim", "No resources."));
	} else {
		for (const resource of result.resources) {
			lines.push(`  ${resource.resourceId}  ${resource.name}${resource.title !== undefined ? ` — ${resource.title}` : ""}`);
			const meta = [resource.mimeType, resource.size !== undefined ? `${resource.size} bytes` : undefined, resource.description]
				.filter((value): value is string => value !== undefined)
				.join(", ");
			if (meta.length > 0) {
				lines.push(`    ${theme.fg("dim", meta)}`);
			}
		}
	}
	if (result.nextCursor !== undefined) {
		lines.push("", theme.fg("dim", `Next page: /mcp resources ${result.serverId} ${result.nextCursor}`));
	}
	lines.push("", theme.fg("dim", "Use /mcp resource <server-id> <resourceId> to read one listed resource."));
	return lines.join("\n");
}

/** Renders one page of the prompts catalog; digest metadata only. */
export function formatMcpPromptList(result: MCPPromptListResult): string {
	const lines = [
		theme.bold(`MCP prompts: ${result.serverId}`),
		theme.fg("dim", "Untrusted catalog metadata; prompt names and arguments are never shown."),
	];
	if (result.prompts.length === 0) {
		lines.push(theme.fg("dim", "No prompts."));
	} else {
		for (const prompt of result.prompts) {
			const argumentsLabel = prompt.arguments.length === 0 ? "" : ` (${prompt.arguments.length} arg${prompt.arguments.length === 1 ? "" : "s"})`;
			lines.push(`  ${prompt.promptId}  ${prompt.name}${argumentsLabel}`);
			const meta = [prompt.title, prompt.description].filter((value): value is string => value !== undefined).join(", ");
			if (meta.length > 0) {
				lines.push(`    ${theme.fg("dim", meta)}`);
			}
		}
	}
	if (result.nextCursor !== undefined) {
		lines.push("", theme.fg("dim", `Next page: /mcp prompts ${result.serverId} ${result.nextCursor}`));
	}
	lines.push("", theme.fg("dim", "Use /mcp prompt <server-id> <promptId> [key=value ...] to get one listed prompt."));
	return lines.join("\n");
}

/** Renders a read receipt: digests and metadata only, labeled untrusted. */
export function formatMcpReadResourceReceipt(result: MCPReadResourceResult): string {
	const provenance = result.provenance;
	const lines = [
		theme.bold("MCP resource read"),
		`${theme.fg("dim", "Resource:")} ${result.resourceId}`,
		`${theme.fg("dim", "Server:")} ${result.serverId}`,
		`${theme.fg("dim", "Untrusted:")} ${provenance.untrusted ? "yes" : "no"}`,
		`${theme.fg("dim", "Provenance:")} source=${provenance.source} content=${provenance.contentDigest} bytes=${provenance.byteCount} blocks=${provenance.blockCount} received=${provenance.receivedAt}`,
	];
	for (const block of result.contents) {
		const mime = block.kind === "image" ? ` ${block.mimeType}` : "";
		const reason = block.kind === "unattached" ? ` (${block.reason})` : "";
		lines.push(`  ${block.kind.padEnd(10)} ${block.bytes} bytes${mime}${reason}  ${theme.fg("dim", block.digest)}`);
	}
	return lines.join("\n");
}

/** Renders a get receipt: digests and metadata only, labeled untrusted. */
export function formatMcpGetPromptReceipt(result: MCPGetPromptResult): string {
	const provenance = result.provenance;
	const lines = [
		theme.bold("MCP prompt fetched"),
		`${theme.fg("dim", "Prompt:")} ${result.promptId}`,
		`${theme.fg("dim", "Server:")} ${result.serverId}`,
		`${theme.fg("dim", "Untrusted:")} ${provenance.untrusted ? "yes" : "no"}`,
		`${theme.fg("dim", "Provenance:")} source=${provenance.source} content=${provenance.contentDigest} bytes=${provenance.byteCount} messages=${result.messages.length} received=${provenance.receivedAt}`,
	];
	for (const message of result.messages) {
		lines.push(`  ${message.role.padEnd(9)} ${message.blocks.length} block(s)  ${theme.fg("dim", message.digest)}`);
	}
	return lines.join("\n");
}

/** Renders an attachment receipt: digests and metadata only. */
export function formatMcpAttachmentReceipt(attachment: McpAttachment): string {
	return [
		theme.bold(`MCP ${attachment.kind} attached`),
		`${theme.fg("dim", "Attachment:")} ${attachment.id}`,
		`${theme.fg("dim", "Server:")} ${attachment.serverId}`,
		`${theme.fg("dim", "Source:")} ${attachment.sourceId}`,
		`${theme.fg("dim", "Content:")} ${attachment.contentDigest}`,
		`${theme.fg("dim", "Size:")} ${attachment.byteCount} bytes, ${attachment.blockCount} blocks (${attachment.attachableBlocks.length} attachable)`,
		theme.fg("dim", "The attachment is untrusted and is never injected into system or developer instructions."),
	].join("\n");
}

/**
 * Format a thrown error from the MCP surface. Only fixed safe templates and
 * stable codes are shown; arbitrary error text is never echoed, so tokens,
 * URLs, raw URIs, prompt arguments, and remote originals cannot leak.
 */
export function formatMcpError(error: unknown): string {
	if (error instanceof McpCommandError || error instanceof MCPError || error instanceof MCPContentError) {
		return theme.fg("error", error.message);
	}
	if (error instanceof MCPAuthError || error instanceof MCPAuthStorageError) {
		return theme.fg("error", error.message);
	}
	if (error instanceof CapabilityError) {
		return `${theme.fg("error", error.code)}: Capability not selected or denied.`;
	}
	if (error instanceof PolicyError) {
		return `${theme.fg("error", error.code)}: Policy did not allow the operation.`;
	}
	return theme.fg("error", "MCP operation failed.");
}
