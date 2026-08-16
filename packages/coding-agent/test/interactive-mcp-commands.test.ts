import { describe, expect, it, vi, beforeEach } from "vitest";
import { MCPAuthError } from "../src/core/mcp-auth.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	initTheme("dark");
});

vi.mock("../src/modes/interactive/components/mcp-auth-dialog.ts", () => {
	return {
		McpAuthDialogComponent: class {
			readonly signal = new AbortController().signal;
			showAuth = vi.fn();
			showProgress = vi.fn();
		},
	};
});

type McpCommandContext = {
	session: {
		settingsManager: {
			getCapabilitySettings: () => {
				mcpServers: ReadonlyArray<{ id: string; transport: string }>;
			};
		};
		getMcpAuthStatus: ReturnType<typeof vi.fn>;
		startMcpAuth: ReturnType<typeof vi.fn>;
		logoutMcpAuth: ReturnType<typeof vi.fn>;
		listMcpResources: ReturnType<typeof vi.fn>;
		listMcpResourceTemplates: ReturnType<typeof vi.fn>;
		listMcpPrompts: ReturnType<typeof vi.fn>;
		readMcpResource: ReturnType<typeof vi.fn>;
		getMcpPrompt: ReturnType<typeof vi.fn>;
		attachMcpResource: ReturnType<typeof vi.fn>;
		attachMcpPrompt: ReturnType<typeof vi.fn>;
		getMcpContentCatalog: ReturnType<typeof vi.fn>;
	};
	chatContainer: { addChild: ReturnType<typeof vi.fn> };
	editorContainer: { clear: ReturnType<typeof vi.fn>; addChild: ReturnType<typeof vi.fn> };
	editor: object;
	ui: { setFocus: ReturnType<typeof vi.fn>; requestRender: ReturnType<typeof vi.fn> };
	showExtensionConfirm: ReturnType<typeof vi.fn>;
	showExtensionInput: ReturnType<typeof vi.fn>;
};

type McpCommandPrototype = {
	handleMcpCommand(this: McpCommandContext, args: string): Promise<void>;
	handleMcpResourcesCommand(this: McpCommandContext, serverId: string): Promise<void>;
	handleMcpResourceCommand(this: McpCommandContext, parts: string[]): Promise<void>;
	handleMcpPromptsCommand(this: McpCommandContext, serverId: string): Promise<void>;
	handleMcpPromptCommand(this: McpCommandContext, parts: string[]): Promise<void>;
	handleMcpAuthCommand(this: McpCommandContext, serverId: string): Promise<void>;
	handleMcpLogoutCommand(this: McpCommandContext, serverId: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as McpCommandPrototype;

function createContext(overrides: Partial<McpCommandContext["session"]> = {}): McpCommandContext {
	const session = {
		settingsManager: {
			getCapabilitySettings: () => ({
				mcpServers: [{ id: "docs", transport: "streamable-http" }],
			}),
		},
		getMcpAuthStatus: vi.fn(),
		startMcpAuth: vi.fn(),
		logoutMcpAuth: vi.fn(),
		listMcpResources: vi.fn(),
		listMcpResourceTemplates: vi.fn(),
		listMcpPrompts: vi.fn(),
		readMcpResource: vi.fn(),
		getMcpPrompt: vi.fn(),
		attachMcpResource: vi.fn(),
		attachMcpPrompt: vi.fn(),
		getMcpContentCatalog: vi.fn(),
		...overrides,
	} as McpCommandContext["session"];
	// Inherit from the prototype so chained handlers (resolveMcpServerId,
	// showMcpOutput, findMcpContentServer) resolve through the class. `session`
	// is an accessor on the prototype, so it must be installed as an own data
	// property via defineProperty instead of a plain assignment.
	const context = Object.create(InteractiveMode.prototype) as McpCommandContext;
	Object.defineProperty(context, "session", {
		value: session,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	Object.assign(context, {
		chatContainer: { addChild: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showExtensionConfirm: vi.fn(),
		showExtensionInput: vi.fn(),
	});
	return context;
}

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

const renderedOutput = (context: McpCommandContext): string =>
	context.chatContainer.addChild.mock.calls
		.map((call) => {
			const component = call[0] as { render?: (width: number) => string[] };
			return component.render?.(200).join("\n") ?? "";
		})
		.join("\n");

describe("InteractiveMode /mcp command dispatch", () => {
	it("shows usage for the bare /mcp command", async () => {
		const context = createContext();
		await prototype.handleMcpCommand.call(context, "");
		const out = stripAnsi(renderedOutput(context));
		expect(out).toContain("/mcp auth <serverId>");
		expect(out).toContain("/mcp prompt [serverId] <name>");
		expect(context.session.listMcpResources).not.toHaveBeenCalled();
	});

	it("lists resources of the sole configured server without an explicit id", async () => {
		const context = createContext();
		context.session.listMcpResources.mockResolvedValue({ items: [], truncated: false });
		context.session.listMcpResourceTemplates.mockResolvedValue({ items: [], truncated: false });
		await prototype.handleMcpCommand.call(context, "resources");
		expect(context.session.listMcpResources).toHaveBeenCalledWith("docs");
		expect(context.session.listMcpResourceTemplates).toHaveBeenCalledWith("docs");
		expect(stripAnsi(renderedOutput(context))).toContain("MCP resources: docs");
	});

	it("rejects an unknown server id without touching the session", async () => {
		const context = createContext();
		await prototype.handleMcpCommand.call(context, "resources nope");
		expect(context.session.listMcpResources).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("MCP server not found: nope");
	});

	it("requires a server id when several servers are configured", async () => {
		const context = createContext();
		context.session.settingsManager.getCapabilitySettings = () => ({
			mcpServers: [
				{ id: "docs", transport: "streamable-http" },
				{ id: "search", transport: "stdio" },
			],
		});
		await prototype.handleMcpCommand.call(context, "prompts");
		expect(context.session.listMcpPrompts).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("Specify an MCP server.");
	});

	it("reads, previews, and attaches a resource only after confirmation", async () => {
		const context = createContext();
		context.session.readMcpResource.mockResolvedValue({
			serverId: "docs",
			uri: "docs://spec.md",
			content: { blocks: [{ type: "text", text: "remote body" }], truncated: false, droppedBlocks: 0, droppedBytes: 0 },
		});
		context.session.attachMcpResource.mockResolvedValue({
			attachmentId: "src-1",
			serverId: "docs",
			contentLength: 11,
			truncated: false,
		});
		context.showExtensionConfirm.mockResolvedValue(true);

		await prototype.handleMcpCommand.call(context, "resource docs docs://spec.md");

		expect(context.session.readMcpResource).toHaveBeenCalledWith("docs", "docs://spec.md");
		// The preview is shown behind the untrusted banner.
		const preview = stripAnsi(String(context.showExtensionConfirm.mock.calls[0]?.[1] ?? ""));
		expect(preview).toContain("UNTRUSTED EXTERNAL MCP CONTENT");
		expect(context.showExtensionConfirm).toHaveBeenCalledOnce();
		expect(context.session.attachMcpResource).toHaveBeenCalledWith("docs", "docs://spec.md");
		expect(stripAnsi(renderedOutput(context))).toContain("MCP content attached for the next turn");
	});

	it("never attaches a resource when the user rejects the preview", async () => {
		const context = createContext();
		context.session.readMcpResource.mockResolvedValue({
			serverId: "docs",
			uri: "docs://spec.md",
			content: { blocks: [], truncated: false, droppedBlocks: 0, droppedBytes: 0 },
		});
		context.showExtensionConfirm.mockResolvedValue(false);

		await prototype.handleMcpResourceCommand.call(context, ["docs", "docs://spec.md"]);

		expect(context.session.attachMcpResource).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("MCP resource not attached.");
	});

	it("resolves the server from the cached catalog when the id is omitted", async () => {
		const context = createContext();
		context.session.getMcpContentCatalog.mockReturnValue({
			resources: [{ uri: "docs://spec.md", name: "spec" }],
			resourceTemplates: [],
			prompts: [],
		});
		context.session.readMcpResource.mockResolvedValue({
			serverId: "docs",
			uri: "docs://spec.md",
			content: { blocks: [], truncated: false, droppedBlocks: 0, droppedBytes: 0 },
		});
		context.session.attachMcpResource.mockResolvedValue({
			attachmentId: "src-1",
			serverId: "docs",
			contentLength: 0,
			truncated: false,
		});
		context.showExtensionConfirm.mockResolvedValue(true);

		await prototype.handleMcpResourceCommand.call(context, ["docs://spec.md"]);

		expect(context.session.readMcpResource).toHaveBeenCalledWith("docs", "docs://spec.md");
		expect(context.session.attachMcpResource).toHaveBeenCalledWith("docs", "docs://spec.md");
	});

	it("reports a resource that was never listed", async () => {
		const context = createContext();
		context.session.getMcpContentCatalog.mockReturnValue(undefined);
		await prototype.handleMcpResourceCommand.call(context, ["docs://missing"]);
		expect(context.session.readMcpResource).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("Resource not listed for any server");
	});

	it("lists prompts of a server", async () => {
		const context = createContext();
		context.session.listMcpPrompts.mockResolvedValue({ items: [{ name: "summarize" }], truncated: false });
		await prototype.handleMcpPromptsCommand.call(context, "docs");
		expect(context.session.listMcpPrompts).toHaveBeenCalledWith("docs");
		expect(stripAnsi(renderedOutput(context))).toContain("summarize");
	});

	it("collects required prompt arguments, previews, and attaches after confirmation", async () => {
		const context = createContext();
		context.session.getMcpContentCatalog.mockReturnValue({
			resources: [],
			resourceTemplates: [],
			prompts: [{ name: "summarize", arguments: [{ name: "uri", required: true }] }],
		});
		context.session.getMcpPrompt.mockResolvedValue({
			serverId: "docs",
			promptName: "summarize",
			messages: [
				{ role: "user", content: { blocks: [{ type: "text", text: "Summarize this" }], truncated: false, droppedBlocks: 0, droppedBytes: 0 } },
			],
		});
		context.session.attachMcpPrompt.mockResolvedValue({
			attachmentId: "src-2",
			serverId: "docs",
			contentLength: 14,
			truncated: false,
		});
		context.showExtensionInput.mockResolvedValue("docs://spec.md");
		context.showExtensionConfirm.mockResolvedValue(true);

		await prototype.handleMcpPromptCommand.call(context, ["docs", "summarize"]);

		expect(context.showExtensionInput).toHaveBeenCalledWith("Value for uri", undefined);
		expect(context.session.getMcpPrompt).toHaveBeenCalledWith("docs", "summarize", { uri: "docs://spec.md" });
		const preview = stripAnsi(String(context.showExtensionConfirm.mock.calls[0]?.[1] ?? ""));
		expect(preview).toContain("UNTRUSTED EXTERNAL MCP CONTENT");
		expect(context.session.attachMcpPrompt).toHaveBeenCalledWith("docs", "summarize", { uri: "docs://spec.md" });
	});

	it("uses inline key=value prompt arguments and rejects malformed ones", async () => {
		const context = createContext();
		context.session.getMcpContentCatalog.mockReturnValue({
			resources: [],
			resourceTemplates: [],
			prompts: [{ name: "summarize", arguments: [{ name: "uri", required: true }] }],
		});
		await prototype.handleMcpPromptCommand.call(context, ["docs", "summarize", "not-an-argument"]);
		expect(context.session.getMcpPrompt).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("expected key=value");
	});

	it("cancels the prompt flow when a required argument prompt is dismissed", async () => {
		const context = createContext();
		context.session.getMcpContentCatalog.mockReturnValue({
			resources: [],
			resourceTemplates: [],
			prompts: [{ name: "summarize", arguments: [{ name: "uri", required: true }] }],
		});
		context.showExtensionInput.mockResolvedValue(undefined);
		await prototype.handleMcpPromptCommand.call(context, ["docs", "summarize"]);
		expect(context.session.getMcpPrompt).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("MCP prompt cancelled.");
	});

	it("starts OAuth only after the user confirms the redacted status", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockResolvedValue({
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "unauthenticated" },
			credential: { serverId: "docs", hasCredential: false, status: "none", expiresAt: 0, scopes: [], revision: 0 },
		});
		context.session.startMcpAuth.mockResolvedValue({
			outcome: "authorized",
			status: { serverId: "docs", state: "authenticated" },
		});
		context.showExtensionConfirm.mockResolvedValue(true);

		await prototype.handleMcpAuthCommand.call(context, "docs");

		// The confirmation showed the redacted status.
		const confirmationMessage = String(context.showExtensionConfirm.mock.calls[0]?.[1] ?? "");
		expect(stripAnsi(confirmationMessage)).toContain("flow state: unauthenticated");
		expect(context.session.startMcpAuth).toHaveBeenCalledOnce();
		expect(stripAnsi(renderedOutput(context))).toContain("MCP OAuth authorized.");
	});

	it("does not start OAuth when the user rejects the status confirmation", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockResolvedValue({
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "unauthenticated" },
			credential: { serverId: "docs", hasCredential: false, status: "none", expiresAt: 0, scopes: [], revision: 0 },
		});
		context.showExtensionConfirm.mockResolvedValue(false);

		await prototype.handleMcpAuthCommand.call(context, "docs");

		expect(context.session.startMcpAuth).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("MCP OAuth cancelled.");
	});

	it("never authenticates stdio servers", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockResolvedValue({
			serverId: "docs",
			authSupported: false,
			auth: { serverId: "docs", state: "unauthenticated" },
			credential: { serverId: "docs", hasCredential: false, status: "none", expiresAt: 0, scopes: [], revision: 0 },
		});
		await prototype.handleMcpAuthCommand.call(context, "docs");
		expect(context.showExtensionConfirm).not.toHaveBeenCalled();
		expect(context.session.startMcpAuth).not.toHaveBeenCalled();
		expect(stripAnsi(renderedOutput(context))).toContain("does not support OAuth");
	});

	it("logs out after confirmation", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockResolvedValue({
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "authenticated" },
			credential: { serverId: "docs", hasCredential: true, status: "authenticated", expiresAt: 0, scopes: [], revision: 1 },
		});
		context.session.logoutMcpAuth.mockResolvedValue(undefined);
		context.showExtensionConfirm.mockResolvedValue(true);

		await prototype.handleMcpLogoutCommand.call(context, "docs");

		expect(context.session.logoutMcpAuth).toHaveBeenCalledWith("docs");
		expect(stripAnsi(renderedOutput(context))).toContain("Logged out of MCP server docs.");
	});

	it("does not log out when the user rejects", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockResolvedValue({
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "authenticated" },
			credential: { serverId: "docs", hasCredential: true, status: "authenticated", expiresAt: 0, scopes: [], revision: 1 },
		});
		context.showExtensionConfirm.mockResolvedValue(false);
		await prototype.handleMcpLogoutCommand.call(context, "docs");
		expect(context.session.logoutMcpAuth).not.toHaveBeenCalled();
	});

	it("shows only fixed redacted errors, never raw remote text", async () => {
		const context = createContext();
		context.session.listMcpResources.mockRejectedValue(new Error("raw remote error with token=super-secret"));
		await prototype.handleMcpResourcesCommand.call(context, "docs");
		const out = stripAnsi(renderedOutput(context));
		expect(out).toContain("MCP command failed.");
		expect(out).not.toContain("raw remote error");
		expect(out).not.toContain("super-secret");
	});

	it("surfaces stable MCP auth errors with their fixed message", async () => {
		const context = createContext();
		context.session.getMcpAuthStatus.mockRejectedValue(new MCPAuthError("mcp_auth_metadata_invalid", "docs"));
		await prototype.handleMcpAuthCommand.call(context, "docs");
		const out = stripAnsi(renderedOutput(context));
		expect(out).toContain("mcp_auth_metadata_invalid");
		expect(out).toContain("invalid OAuth metadata");
	});
});
