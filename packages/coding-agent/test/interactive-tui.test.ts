import type { Component, Terminal, TUI } from "@aos-agent/tui";
import { Container, isViewportTUI, Text } from "@aos-agent/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CapabilityError, type CapabilityBinding, type CapabilityCatalogView } from "../src/core/capability-registry.ts";
import type { FullscreenExitOutput, TuiMode } from "../src/core/settings-manager.ts";
import {
	formatCapabilitiesError,
	formatCapabilitiesUsage,
	formatCapabilityApproval,
	formatCapabilityCatalog,
	formatCapabilityDescriptor,
} from "../src/modes/interactive/capabilities.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});

	it("replaces the renderer and restores the previous screen for resume-hint exits", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { stopInteractiveTui, switchTuiMode } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: SwitchContext, fullscreenExitOutput: FullscreenExitOutput): void;
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		stopInteractiveTui.call(context, "resume-hint");

		expect(stableUi.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 2]);
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("keeps the status-line confirmation for the copy shortcut in regular mode", async () => {
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });

		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [tuiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				options: { tuiMode },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});

const sampleCapabilityCatalog: CapabilityCatalogView = {
	version: 1,
	descriptors: [
		{
			id: "builtin_tool:local:read",
			revision: "rev:abc123",
			kind: "builtin_tool",
			name: "Read File",
			source: {
			source: "local",
			scope: "user",
			origin: "top-level",
		},
			availability: "available",
			decision: "allow",
			trusted: true,
			exposedToolName: "read",
		},
		{
			id: "mcp_server:my-server:server",
			revision: "rev:def456",
			kind: "mcp_server",
			name: "My Server",
			source: { source: "npm:my-server", scope: "project", origin: "package" },
			availability: "available",
			decision: "ask",
			trusted: true,
			exposedToolName: "mcp__my-server__server",
			mcpServerId: "my-server",
		},
	],
};

const sampleCapabilityBinding: CapabilityBinding = {
	id: "binding:default:abc",
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [{ id: "builtin_tool:local:read", revision: "rev:abc123", exposedToolName: "read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 1, denied: 0 },
	toolAllowlist: ["read"],
};

describe("capability formatters", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	const plain = (info: string): string => info.replace(/\x1b\[[0-9;]*m/g, "");

	it("lists kind, name, source, revision, availability, decision, and selected status", () => {
		const info = plain(
			formatCapabilityCatalog(sampleCapabilityCatalog, new Set(["builtin_tool:local:read"])),
		);
		expect(info).toContain("Capabilities (2)");
		expect(info).toContain("builtin_tool:local:read");
		expect(info).toContain("mcp_server:my-server:server");
		expect(info).toContain("Read File");
		expect(info).toContain("rev:abc123");
		expect(info).toContain("npm:my-server (project, package)");
		expect(info).toContain("selected");
	});

	it("omits raw local paths from the catalog listing", () => {
		const info = plain(formatCapabilityCatalog(sampleCapabilityCatalog, new Set()));
		expect(info).not.toContain("/private/raw/path/read.ts");
		expect(info).not.toContain("/private/raw/base");
	});

	it("annotates a discovery failure without echoing arbitrary messages", () => {
		const info = plain(formatCapabilityCatalog(sampleCapabilityCatalog, new Set(), "capability_mcp_connect_failed"));
		expect(info).toContain("Discovery: capability_mcp_connect_failed");
		expect(info).toContain("builtin_tool:local:read");
	});

	it("renders descriptor details for inspect without raw paths", () => {
		const descriptor = sampleCapabilityCatalog.descriptors[0]!;
		const info = plain(
			formatCapabilityDescriptor(descriptor, {
				profile: "default",
				bindingId: "binding:default:abc",
				selected: true,
			}),
		);
		expect(info).toContain("Capability: Read File");
		expect(info).toContain("Profile rule: allow");
		expect(info).toContain("Profile: default");
		expect(info).toContain("Binding: binding:default:abc");
		expect(info).toContain("Selected: yes");
		expect(info).toContain("rev:abc123");
		expect(info).toContain("local (user, top-level)");
		expect(info).not.toContain("/private/raw/path/read.ts");
		expect(info).not.toContain("/private/raw/base");
	});

	it("formats approval and usage", () => {
		expect(formatCapabilityApproval("mcp_server:my-server:server")).toContain(
			"mcp_server:my-server:server",
		);
		expect(formatCapabilitiesUsage()).toContain("/capabilities inspect <id>");
		expect(formatCapabilitiesUsage()).toContain("/capabilities approve <id>");
	});

	it("formats CapabilityError with its redacted code and message", () => {
		const error = new CapabilityError("capability_denied", "Cannot approve unknown capability: nope");
		const info = plain(formatCapabilitiesError(error));
		expect(info).toContain("capability_denied");
		expect(info).toContain("Cannot approve unknown capability: nope");
	});

	it("does not echo arbitrary error messages", () => {
		const info = plain(formatCapabilitiesError(new Error("secret internal detail")));
		expect(info).toContain("Capability failure.");
		expect(info).not.toContain("secret internal detail");
	});
});

type CapabilitiesSession = {
	whenCapabilitiesReady: () => Promise<void>;
	inspectCapabilityCatalog: () => CapabilityCatalogView;
	approveCapability: (descriptorId: string) => Promise<void>;
	getActiveCapabilityBinding: () => CapabilityBinding | undefined;
	getActiveCapabilityProfile: () => string;
};

type CapabilitiesCommandContext = {
	session: CapabilitiesSession;
	chatContainer: Container;
	ui: { requestRender: () => void };
};

type CapabilitiesCommandPrototype = {
	handleCapabilitiesCommand(this: CapabilitiesCommandContext, args: string): Promise<void>;
};

const capabilitiesCommandPrototype = InteractiveMode.prototype as unknown as CapabilitiesCommandPrototype;

function createCapabilitiesContext(overrides?: Partial<CapabilitiesSession>): CapabilitiesCommandContext {
	const session: CapabilitiesSession = {
		whenCapabilitiesReady: async () => {},
		inspectCapabilityCatalog: () => sampleCapabilityCatalog,
		approveCapability: async () => {},
		getActiveCapabilityBinding: () => sampleCapabilityBinding,
		getActiveCapabilityProfile: () => "default",
		...overrides,
	};
	return {
		session,
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode /capabilities command", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	const rendered = (context: CapabilitiesCommandContext): string =>
		context.chatContainer.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	it("renders the capability catalog for the bare command", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "");
		const output = rendered(context);
		expect(output).toContain("Capabilities (2)");
		expect(output).toContain("builtin_tool:local:read");
		expect(output).toContain("mcp_server:my-server:server");
		expect(context.ui.requestRender).toHaveBeenCalled();
	});

	it("marks only binding-selected descriptors in the catalog", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "");
		const output = rendered(context);
		expect(output).toContain("Read File selected");
		expect(output).not.toContain("My Server selected");
	});

	it("renders a descriptor for /capabilities inspect <id>", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "inspect mcp_server:my-server:server");
		const output = rendered(context);
		expect(output).toContain("Capability: My Server");
		expect(output).toContain("Profile rule: ask");
		expect(output).toContain("Profile: default");
		expect(output).toContain("Binding: binding:default:abc");
		expect(output).toContain("npm:my-server (project, package)");
	});

	it("reports usage for /capabilities inspect without an id", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "inspect");
		expect(rendered(context)).toContain("/capabilities inspect <id>");
	});

	it("reports an unknown id for /capabilities inspect <id>", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "inspect nope");
		expect(rendered(context)).toContain("Capability not found: nope");
	});

	it("approves an ask capability for the session", async () => {
		const approveSpy = vi.fn(async () => {});
		const context = createCapabilitiesContext({ approveCapability: approveSpy });
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "approve mcp_server:my-server:server");
		expect(approveSpy).toHaveBeenCalledWith("mcp_server:my-server:server");
		expect(rendered(context)).toContain("Approved mcp_server:my-server:server for this session");
	});

	it("reports usage for /capabilities approve without an id", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "approve");
		expect(rendered(context)).toContain("/capabilities approve <id>");
	});

	it("surfaces a CapabilityError from approval without echoing arbitrary text", async () => {
		const context = createCapabilitiesContext({
			approveCapability: async () => {
				throw new CapabilityError("capability_denied", "Cannot approve unknown capability: nope");
			},
		});
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "approve nope");
		const output = rendered(context);
		expect(output).toContain("capability_denied");
		expect(output).toContain("Cannot approve unknown capability: nope");
	});

	it("does not echo arbitrary discovery errors", async () => {
		const context = createCapabilitiesContext({
			whenCapabilitiesReady: async () => {
				throw new Error("secret discovery detail");
			},
		});
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "");
		const output = rendered(context);
		expect(output).toContain("Capability failure.");
		expect(output).not.toContain("secret discovery detail");
	});

	it("reports an unknown subcommand", async () => {
		const context = createCapabilitiesContext();
		await capabilitiesCommandPrototype.handleCapabilitiesCommand.call(context, "frobnicate");
		expect(rendered(context)).toContain("Unknown /capabilities subcommand: frobnicate");
	});
});
