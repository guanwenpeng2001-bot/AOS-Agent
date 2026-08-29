import { describe, expect, it, vi } from "vitest";
import { MCPAuthError } from "../src/core/policy/mcp-auth.ts";
import type { McpAttachment } from "../src/core/runtime/mcp-attachment.ts";
import type { MCPGetPromptResult, MCPNormalizedContentBlock, MCPReadResourceResult } from "../src/core/runtime/mcp-content.ts";
import { MCPContentError } from "../src/core/runtime/mcp-content.ts";
import { MCPError, type MCPPromptListResult, type MCPResourceListResult } from "../src/core/runtime/mcp-types.ts";
import { CapabilityError } from "../src/core/policy/capability-registry.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	formatMcpAttachmentReceipt,
	formatMcpError,
	formatMcpGetPromptReceipt,
	formatMcpReadResourceReceipt,
	parseMcpCommandArgs,
} from "../src/modes/interactive/mcp.ts";
import { McpCommandError } from "../src/modes/interactive/mcp.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

const SERVER_ID = "docs";
const RAW_URI = "docs://README.md";
const REMOTE_TEXT = "this is remote original text that must never be rendered";
const PROMPT_NAME = "summarize";
const PROMPT_ARGS = { lang: "xyzzy" };

const DIGEST_1 = "digest-one-1111111111111111111111111111111111111111111111";
const DIGEST_2 = "digest-two-2222222222222222222222222222222222222222222222";
const CONTENT_DIGEST = "content-digest-3333333333333333333333333333333333333333333333";

function textBlock(text: string): MCPNormalizedContentBlock {
	return { kind: "text", text, bytes: Buffer.byteLength(text, "utf8"), digest: DIGEST_1 };
}

function readResult(overrides: Partial<MCPReadResourceResult> = {}): MCPReadResourceResult {
	return {
		serverId: SERVER_ID,
		resourceId: "resource-id-digest",
		contents: [textBlock(REMOTE_TEXT), { kind: "image", data: "aGVsbG8=", mimeType: "image/png", bytes: 7, digest: DIGEST_2 }],
		provenance: {
			serverId: SERVER_ID,
			source: "resource",
			sourceId: "resource-id-digest",
			contentDigest: CONTENT_DIGEST,
			byteCount: 123,
			blockCount: 2,
			untrusted: true,
			receivedAt: "2026-08-16T00:00:00.000Z",
		},
		...overrides,
	};
}

function promptResult(overrides: Partial<MCPGetPromptResult> = {}): MCPGetPromptResult {
	return {
		serverId: SERVER_ID,
		promptId: "prompt-id-digest",
		messages: [
			{
				role: "user",
				blocks: [textBlock(REMOTE_TEXT)],
				digest: DIGEST_1,
			},
		],
		provenance: {
			serverId: SERVER_ID,
			source: "prompt",
			sourceId: "prompt-id-digest",
			contentDigest: CONTENT_DIGEST,
			byteCount: 456,
			blockCount: 1,
			untrusted: true,
			receivedAt: "2026-08-16T00:00:00.000Z",
		},
		...overrides,
	};
}

function attachmentFixture(overrides: Partial<McpAttachment> = {}): McpAttachment {
	return {
		id: "attachment-id-digest",
		kind: "resource",
		serverId: SERVER_ID,
		sourceId: "resource-id-digest",
		provenance: {
			serverId: SERVER_ID,
			source: "resource",
			sourceId: "resource-id-digest",
			contentDigest: CONTENT_DIGEST,
			byteCount: 123,
			blockCount: 2,
			untrusted: true,
			receivedAt: "2026-08-16T00:00:00.000Z",
		},
		contentDigest: CONTENT_DIGEST,
		byteCount: 123,
		blockCount: 2,
		capabilityBindingId: "capability:binding:test",
		policyBindingId: "policy:binding:test",
		attachableBlocks: [textBlock(REMOTE_TEXT)],
		text: REMOTE_TEXT,
		createdAt: "2026-08-16T00:00:00.000Z",
		...overrides,
	};
}

function resourceListResult(): MCPResourceListResult {
	return {
		serverId: SERVER_ID,
		resources: [
			{
				resourceId: "resource-id-digest",
				serverId: SERVER_ID,
				name: "README",
				mimeType: "text/markdown",
				size: 2048,
				provenanceId: "provenance-digest",
				revision: "revision-digest",
			},
		],
	};
}

function promptListResult(): MCPPromptListResult {
	return {
		serverId: SERVER_ID,
		prompts: [
			{
				promptId: "prompt-id-digest",
				serverId: SERVER_ID,
				name: PROMPT_NAME,
				arguments: [{ name: "language", required: true }],
				provenanceId: "provenance-digest",
				revision: "revision-digest",
			},
		],
	};
}

describe("parseMcpCommandArgs", () => {
	it("parses the bare command", () => {
		expect(parseMcpCommandArgs("")).toEqual({ ok: true, command: { sub: undefined } });
	});

	it("parses auth and logout with optional server id", () => {
		expect(parseMcpCommandArgs("auth")).toEqual({ ok: true, command: { sub: "auth" } });
		expect(parseMcpCommandArgs("auth docs")).toEqual({ ok: true, command: { sub: "auth", serverId: "docs" } });
		expect(parseMcpCommandArgs("logout docs")).toEqual({ ok: true, command: { sub: "logout", serverId: "docs" } });
		expect(parseMcpCommandArgs("auth docs extra")).toEqual({ ok: false, error: "Too many arguments." });
	});

	it("parses resources and prompts with optional cursor", () => {
		expect(parseMcpCommandArgs("resources docs")).toEqual({ ok: true, command: { sub: "resources", serverId: "docs" } });
		expect(parseMcpCommandArgs("resources docs cursor-1")).toEqual({
			ok: true,
			command: { sub: "resources", serverId: "docs", cursor: "cursor-1" },
		});
		expect(parseMcpCommandArgs("prompts docs cursor-1")).toEqual({
			ok: true,
			command: { sub: "prompts", serverId: "docs", cursor: "cursor-1" },
		});
		expect(parseMcpCommandArgs("resources docs a b")).toEqual({ ok: false, error: "Too many arguments." });
	});

	it("parses resource with a required resourceId", () => {
		expect(parseMcpCommandArgs("resource docs res_abc")).toEqual({
			ok: true,
			command: { sub: "resource", serverId: "docs", resourceId: "res_abc" },
		});
		expect(parseMcpCommandArgs("resource docs")).toEqual({
			ok: false,
			error: "Usage: /mcp resource <server-id> <resourceId>",
		});
	});

	it("parses prompt with required promptId and optional key=value args", () => {
		expect(parseMcpCommandArgs("prompt docs summarize")).toEqual({
			ok: true,
			command: { sub: "prompt", serverId: "docs", promptId: "summarize", args: {} },
		});
		expect(parseMcpCommandArgs("prompt docs summarize language=rust")).toEqual({
			ok: true,
			command: { sub: "prompt", serverId: "docs", promptId: "summarize", args: { language: "rust" } },
		});
		expect(parseMcpCommandArgs("prompt docs summarize language=rust a=b=c")).toEqual({
			ok: true,
			command: { sub: "prompt", serverId: "docs", promptId: "summarize", args: { language: "rust", a: "b=c" } },
		});
		expect(parseMcpCommandArgs("prompt docs summarize broken")).toEqual({
			ok: false,
			error: "Invalid /mcp prompt arguments: expected key=value pairs.",
		});
		expect(parseMcpCommandArgs("prompt docs")).toEqual({
			ok: false,
			error: "Usage: /mcp prompt <server-id> <promptId> [key=value ...]",
		});
	});

	it("rejects unknown subcommands without echoing the argument", () => {
		const result = parseMcpCommandArgs("explode docs");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("explode");
		}
	});
});

describe("MCP content formatting sanitization", () => {
	it("read receipts show digests and untrusted provenance, never the raw uri or remote text", () => {
		const rendered = stripAnsi(formatMcpReadResourceReceipt(readResult()));
		expect(rendered).toContain("resource-id-digest");
		expect(rendered).toContain("Untrusted: yes");
		expect(rendered).toContain(CONTENT_DIGEST);
		expect(rendered).toContain(DIGEST_1);
		expect(rendered).toContain("image/png");
		expect(rendered).not.toContain(RAW_URI);
		expect(rendered).not.toContain(REMOTE_TEXT);
	});

	it("get receipts show digests and provenance, never the prompt name, args, or remote text", () => {
		const rendered = stripAnsi(formatMcpGetPromptReceipt(promptResult()));
		expect(rendered).toContain("prompt-id-digest");
		expect(rendered).toContain("Untrusted: yes");
		expect(rendered).not.toContain(PROMPT_NAME);
		expect(rendered).not.toContain("language");
		expect(rendered).not.toContain("xyzzy");
		expect(rendered).not.toContain(REMOTE_TEXT);
	});

	it("attachment receipts never surface the raw uri or remote text", () => {
		const rendered = stripAnsi(formatMcpAttachmentReceipt(attachmentFixture()));
		expect(rendered).toContain("attachment-id-digest");
		expect(rendered).toContain("never injected into system or developer instructions");
		expect(rendered).not.toContain(RAW_URI);
		expect(rendered).not.toContain(REMOTE_TEXT);
	});
});

describe("formatMcpError", () => {
	it("shows fixed lifecycle messages", () => {
		expect(stripAnsi(formatMcpError(new MCPError("connect_failed", SERVER_ID, `Failed to connect to MCP server "${SERVER_ID}"`)))).toBe(
			`Failed to connect to MCP server "${SERVER_ID}"`,
		);
	});

	it("shows fixed content-safety messages", () => {
		expect(stripAnsi(formatMcpError(new MCPContentError("mcp_content_unsupported", SERVER_ID)))).toBe(
			`MCP server "${SERVER_ID}" returned unsupported content`,
		);
	});

	it("shows stable capability codes without echoing arbitrary messages", () => {
		const rendered = stripAnsi(formatMcpError(new CapabilityError("capability_denied", "secret detail that must not leak")));
		expect(rendered).toContain("capability_denied");
		expect(rendered).not.toContain("secret detail");
	});

	it("never echoes arbitrary error text", () => {
		expect(stripAnsi(formatMcpError(new Error(`leaked token: ${RAW_URI}`)))).toBe("MCP operation failed.");
		expect(stripAnsi(formatMcpError("string error"))).toBe("MCP operation failed.");
	});

	it("shows fixed local command errors", () => {
		expect(stripAnsi(formatMcpError(new McpCommandError(`MCP server "${SERVER_ID}" is not configured.`)))).toBe(
			`MCP server "${SERVER_ID}" is not configured.`,
		);
	});
});

// ---------------------------------------------------------------------------
// handleMcpCommand with a mocked InteractiveMode context
// ---------------------------------------------------------------------------

type McpCommandContext = {
	chatContainer: { addChild: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
	session: {
		settingsManager: {
			getCapabilitySettings: () => {
				mcpServers: Array<{
					id: string;
					trusted: boolean;
					server: { transport: "stdio" | "streamable-http"; url?: string; command?: string };
				}>;
			};
		};
		listMcpResources: ReturnType<typeof vi.fn>;
		readMcpResource: ReturnType<typeof vi.fn>;
		attachMcpResource: ReturnType<typeof vi.fn>;
		listMcpPrompts: ReturnType<typeof vi.fn>;
		getMcpPrompt: ReturnType<typeof vi.fn>;
		attachMcpPrompt: ReturnType<typeof vi.fn>;
		getMcpConnectionStatus: ReturnType<typeof vi.fn>;
		startMcpAuth: ReturnType<typeof vi.fn>;
		logoutMcpAuth: ReturnType<typeof vi.fn>;
		getMcpAuthStatus: ReturnType<typeof vi.fn>;
	};
	showExtensionConfirm: ReturnType<typeof vi.fn>;
	showExtensionInput: ReturnType<typeof vi.fn>;
	hideExtensionSelector: ReturnType<typeof vi.fn>;
	disposeActiveSelector: ReturnType<typeof vi.fn>;
	editorContainer: { clear: ReturnType<typeof vi.fn>; addChild: ReturnType<typeof vi.fn> };
	handleMcpCommand: (this: McpCommandContext, args: string) => Promise<void>;
	formatMcpOverview: (this: McpCommandContext) => Promise<string>;
	isMcpServerAuthorized: (this: McpCommandContext, serverId: string, serverUrl: string) => Promise<boolean>;
	runMcpAuth: (this: McpCommandContext, serverId: string) => Promise<string>;
	runMcpLogout: (this: McpCommandContext, serverId: string) => Promise<string>;
	showMcpAuthPrompt: (this: McpCommandContext, prompt: unknown) => Promise<string>;
	notifyMcpAuthEvent: (this: McpCommandContext, event: unknown) => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as Record<string, unknown>;

function prototypeMethod<K extends keyof McpCommandContext>(key: K): McpCommandContext[K] {
	const method = interactiveModePrototype[key as string];
	if (typeof method !== "function") {
		throw new Error(`Missing InteractiveMode prototype method: ${key as string}`);
	}
	return method as McpCommandContext[K];
}

function createContext(overrides: Partial<McpCommandContext> = {}): McpCommandContext {
	return {
		chatContainer: { addChild: vi.fn(), clear: vi.fn(), removeChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		session: {
			settingsManager: {
				getCapabilitySettings: () => ({
					mcpServers: [
						{
							id: SERVER_ID,
							trusted: true,
							server: { transport: "streamable-http", url: "https://mcp.example.invalid/mcp" },
						},
						{ id: "local", trusted: true, server: { transport: "stdio", command: "node" } },
					],
				}),
			},
			listMcpResources: vi.fn(async () => resourceListResult()),
			readMcpResource: vi.fn(async () => readResult()),
			attachMcpResource: vi.fn(async () => attachmentFixture()),
			listMcpPrompts: vi.fn(async () => promptListResult()),
			getMcpPrompt: vi.fn(async () => promptResult()),
			attachMcpPrompt: vi.fn(async () => attachmentFixture({ kind: "prompt", sourceId: "prompt-id-digest" })),
			getMcpConnectionStatus: vi.fn(() => undefined),
			startMcpAuth: vi.fn(async () => ({ status: "authorized" })),
			logoutMcpAuth: vi.fn(async () => {}),
			getMcpAuthStatus: vi.fn(() => undefined),
		},
		showExtensionConfirm: vi.fn(async () => true),
		showExtensionInput: vi.fn(async () => undefined),
		hideExtensionSelector: vi.fn(),
		disposeActiveSelector: vi.fn(),
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		handleMcpCommand: prototypeMethod("handleMcpCommand"),
		formatMcpOverview: prototypeMethod("formatMcpOverview"),
		isMcpServerAuthorized: prototypeMethod("isMcpServerAuthorized"),
		runMcpAuth: prototypeMethod("runMcpAuth"),
		runMcpLogout: prototypeMethod("runMcpLogout"),
		showMcpAuthPrompt: prototypeMethod("showMcpAuthPrompt"),
		notifyMcpAuthEvent: prototypeMethod("notifyMcpAuthEvent"),
		...overrides,
	};
}

function lastRenderedText(context: McpCommandContext): string {
	const children = context.chatContainer.addChild.mock.calls.map((call) => call[0]);
	const text = children.filter((child) => typeof (child as { render?: unknown }).render === "function").at(-1);
	expect(text).toBeDefined();
	return stripAnsi((text as { render: (width: number) => string[] }).render(200).join("\n"));
}

describe("InteractiveMode /mcp command handler", () => {
	const handleMcpCommand = (context: McpCommandContext, args: string): Promise<void> =>
		context.handleMcpCommand.call(context, args);

	it("lists resources through the session method and renders digest metadata only", async () => {
		const context = createContext();
		await handleMcpCommand(context, "resources docs");
		expect(context.session.listMcpResources).toHaveBeenCalledWith("docs", undefined);
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("resource-id-digest");
		expect(rendered).toContain("README");
		expect(rendered).toContain("Untrusted");
		expect(rendered).not.toContain(RAW_URI);
		expect(rendered).not.toContain("mcp.example.invalid");
	});

	it("lists prompts through the session method and renders digest metadata only", async () => {
		const context = createContext();
		await handleMcpCommand(context, "prompts docs");
		expect(context.session.listMcpPrompts).toHaveBeenCalledWith("docs", undefined);
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("prompt-id-digest");
		expect(rendered).toContain("Untrusted");
		expect(rendered).not.toContain("xyzzy");
	});

	it("passes the opaque cursor to the list methods", async () => {
		const context = createContext();
		await handleMcpCommand(context, "resources docs cursor-1");
		expect(context.session.listMcpResources).toHaveBeenCalledWith("docs", { cursor: "cursor-1" });
	});

	it("reads a resource explicitly, then attaches after explicit confirmation", async () => {
		const context = createContext();
		await handleMcpCommand(context, `resource docs ${RAW_URI}`);
		expect(context.session.readMcpResource).toHaveBeenCalledWith("docs", RAW_URI);
		expect(context.showExtensionConfirm).toHaveBeenCalled();
		expect(context.session.attachMcpResource).toHaveBeenCalledWith({ serverId: "docs", uri: RAW_URI });
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("attached");
		expect(rendered).toContain("attachment-id-digest");
		expect(rendered).not.toContain(RAW_URI);
		expect(rendered).not.toContain(REMOTE_TEXT);
	});

	it("never attaches when the user rejects the confirmation", async () => {
		const context = createContext({ showExtensionConfirm: vi.fn(async () => false) });
		await handleMcpCommand(context, `resource docs ${RAW_URI}`);
		expect(context.session.readMcpResource).toHaveBeenCalledWith("docs", RAW_URI);
		expect(context.session.attachMcpResource).not.toHaveBeenCalled();
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("Attachment cancelled.");
	});

	it("gets a prompt with args explicitly, then attaches only after confirmation", async () => {
		const context = createContext();
		await handleMcpCommand(context, `prompt docs ${PROMPT_NAME} lang=xyzzy`);
		expect(context.session.getMcpPrompt).toHaveBeenCalledWith("docs", PROMPT_NAME, PROMPT_ARGS);
		expect(context.session.attachMcpPrompt).toHaveBeenCalledWith({
			serverId: "docs",
			name: PROMPT_NAME,
			args: PROMPT_ARGS,
		});
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("attached");
		expect(rendered).not.toContain(PROMPT_NAME);
		expect(rendered).not.toContain("lang=xyzzy");
		expect(rendered).not.toContain("xyzzy");
		expect(rendered).not.toContain(REMOTE_TEXT);
	});

	it("rejects a prompt attachment when the user declines", async () => {
		const context = createContext({ showExtensionConfirm: vi.fn(async () => false) });
		await handleMcpCommand(context, `prompt docs ${PROMPT_NAME} lang=xyzzy`);
		expect(context.session.getMcpPrompt).toHaveBeenCalledWith("docs", PROMPT_NAME, PROMPT_ARGS);
		expect(context.session.attachMcpPrompt).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain("Attachment cancelled.");
	});

	it("shows a fixed safe message when a content operation fails", async () => {
		const context = createContext({
			session: {
				...createContext().session,
				readMcpResource: vi.fn(async () => {
					throw new MCPContentError("mcp_content_malformed", "docs");
				}),
			},
		});
		await handleMcpCommand(context, `resource docs ${RAW_URI}`);
		const rendered = lastRenderedText(context);
		expect(rendered).toContain(`MCP server "${SERVER_ID}" returned malformed content`);
		expect(rendered).not.toContain(RAW_URI);
	});

	it("shows usage errors for missing arguments", async () => {
		const context = createContext();
		await handleMcpCommand(context, "resource docs");
		expect(context.session.readMcpResource).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain("Usage: /mcp resource <server-id> <resourceId>");
	});

	it("shows a fixed message for an unknown subcommand", async () => {
		const context = createContext();
		await handleMcpCommand(context, "explode");
		expect(lastRenderedText(context)).toContain("Unknown /mcp subcommand: explode");
	});

	it("rejects /mcp auth for a stdio server before touching the session", async () => {
		const startMcpAuth = vi.fn(async () => ({ status: "authorized" as const }));
		const context = createContext({
			session: {
				...createContext().session,
				startMcpAuth,
			},
		});
		await handleMcpCommand(context, "auth local");
		expect(startMcpAuth).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain(`MCP server "local" uses stdio and does not support OAuth.`);
	});

	it("rejects /mcp auth for an unconfigured server", async () => {
		const context = createContext();
		await handleMcpCommand(context, "auth nope");
		expect(context.session.startMcpAuth).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain(`MCP server "nope" is not configured.`);
	});

	it("shows a fixed classified message when the OAuth flow fails", async () => {
		const context = createContext({
			session: {
				...createContext().session,
				startMcpAuth: vi.fn(async () => {
					throw new MCPAuthError("auth_failed", "docs");
				}),
			},
		});
		await handleMcpCommand(context, "auth docs");
		const rendered = lastRenderedText(context);
		expect(rendered).toContain(`MCP server "${SERVER_ID}"`);
		expect(rendered).not.toContain("mcp.example.invalid");
		expect(rendered).not.toContain("secret");
	});

	it("reports a completed OAuth authorization without echoing tokens", async () => {
		const startMcpAuth = vi.fn(async () => ({ status: "authorized" as const }));
		const context = createContext({
			session: { ...createContext().session, startMcpAuth },
		});
		await handleMcpCommand(context, "auth docs");
		expect(startMcpAuth).toHaveBeenCalledWith(
			"docs",
			"https://mcp.example.invalid/mcp",
			expect.objectContaining({ interaction: expect.any(Object) }),
		);
		const rendered = lastRenderedText(context);
		expect(rendered).toContain(`MCP server "${SERVER_ID}" OAuth authorization completed.`);
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("token");
		expect(rendered).not.toContain("mcp.example.invalid");
	});

	it("reports when the server does not advertise OAuth", async () => {
		const context = createContext({
			session: {
				...createContext().session,
				startMcpAuth: vi.fn(async () => ({ status: "not_required" as const })),
			},
		});
		await handleMcpCommand(context, "auth docs");
		expect(lastRenderedText(context)).toContain(
			`MCP server "${SERVER_ID}" does not advertise OAuth and connects unauthenticated.`,
		);
	});

	it("logs out a streamable-http server by removing the stored credential", async () => {
		const logoutMcpAuth = vi.fn(async () => {});
		const context = createContext({
			session: { ...createContext().session, logoutMcpAuth },
		});
		await handleMcpCommand(context, "logout docs");
		expect(logoutMcpAuth).toHaveBeenCalledWith("docs", "https://mcp.example.invalid/mcp");
		expect(lastRenderedText(context)).toContain(`MCP server "${SERVER_ID}" OAuth credential removed.`);
	});

	it("rejects /mcp logout for an unconfigured server before calling the session", async () => {
		const context = createContext();
		await handleMcpCommand(context, "logout nope");
		expect(context.session.logoutMcpAuth).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain(`MCP server "nope" is not configured.`);
	});

	it("rejects /mcp logout for a stdio server before touching the session", async () => {
		const logoutMcpAuth = vi.fn(async () => {});
		const context = createContext({
			session: { ...createContext().session, logoutMcpAuth },
		});
		await handleMcpCommand(context, "logout local");
		expect(logoutMcpAuth).not.toHaveBeenCalled();
		expect(lastRenderedText(context)).toContain(`MCP server "local" uses stdio and does not support OAuth.`);
	});

	it("overview output never contains server URLs", async () => {
		const context = createContext();
		await handleMcpCommand(context, "");
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("MCP servers (2)");
		expect(rendered).toContain("docs");
		expect(rendered).not.toContain("mcp.example.invalid");
		expect(rendered).not.toContain("https://");
		// The status is awaited and only queried for streamable-http servers;
		// stdio servers are never handed to the credential namespace.
		expect(context.session.getMcpAuthStatus).toHaveBeenCalledTimes(1);
		expect(context.session.getMcpAuthStatus).toHaveBeenCalledWith("docs", "https://mcp.example.invalid/mcp");
	});

	it("overview awaits the stored credential status and never renders issuer/resource", async () => {
		const getMcpAuthStatus = vi.fn(async () => ({
			serverIdentity: "opaque-server-identity",
			serverUrl: "https://mcp.example.invalid/mcp",
			issuer: "https://issuer.example.invalid",
			resource: "https://mcp.example.invalid/mcp",
			scope: "mcp",
			hasRefreshToken: true,
		}));
		const context = createContext({
			session: { ...createContext().session, getMcpAuthStatus },
		});
		await handleMcpCommand(context, "");
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("oauth=authorized");
		expect(rendered).toContain("oauth=n/a");
		expect(rendered).not.toContain("issuer.example.invalid");
		expect(rendered).not.toContain("mcp.example.invalid");
		expect(rendered).not.toContain("opaque-server-identity");
	});

	it("overview degrades to oauth=none when the status read fails", async () => {
		const getMcpAuthStatus = vi.fn(async () => {
			throw new Error("storage unavailable");
		});
		const context = createContext({
			session: { ...createContext().session, getMcpAuthStatus },
		});
		await handleMcpCommand(context, "");
		const rendered = lastRenderedText(context);
		expect(rendered).toContain("oauth=none");
		expect(rendered).not.toContain("storage unavailable");
	});
});
