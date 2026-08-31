import { fakeAssistantMessage } from "@aos-agent/ai";
import { Container, Text } from "@aos-agent/tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, ExtensionBindings } from "../../../src/core/session/agent-session.ts";
import type { PreparedSessionScopeRebind } from "../../../src/core/session/current-scope.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

type LoadedResourcesResult<T> = { [K in keyof T]: T[K] } & { diagnostics: [] };

type LoadedResourcesContext = {
	loadedResourcesContainer: Container;
	chatContainer: Container;
	options: { verbose?: boolean };
	settingsManager: { getQuietStartup: () => boolean };
	sessionManager: { getCwd: () => string };
	session: {
		promptTemplates: [];
		resourceLoader: {
			getAgentsFiles: () => LoadedResourcesResult<{ agentsFiles: Array<{ path: string }> }>;
			getSystemPromptSource: () => { path: string } | undefined;
			getAppendSystemPromptSources: () => Array<{ path: string }>;
			getSkills: () => LoadedResourcesResult<{ skills: [] }>;
			getPrompts: () => LoadedResourcesResult<{ prompts: [] }>;
			getThemes: () => LoadedResourcesResult<{ themes: [] }>;
			getExtensions: () => { extensions: []; errors: [] };
		};
		extensionRunner: {
			getCommandDiagnostics: () => [];
			getShortcutDiagnostics: () => [];
			getRegisteredCommands: () => [];
		};
	};
	getStartupExpansionState: () => boolean;
	formatDisplayPath: (resourcePath: string) => string;
	formatContextPath: (resourcePath: string) => string;
	getBuiltInCommandConflictDiagnostics: (extensionRunner: LoadedResourcesContext["session"]["extensionRunner"]) => [];
};

type RebindContext = {
	sessionSubscriptions: Map<AgentSession, () => void>;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: (session: AgentSession) => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type ReloadCommandContext = {
	hideThinkingBlock: boolean;
	runtimeHost: {
		reload: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>;
	};
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		resourceLoader: { getThemes: () => { themes: [] } };
		extensionRunner: unknown;
		modelRegistry: { getError: () => string | undefined };
	};
	settingsManager: {
		getHttpIdleTimeoutMs: () => number;
		getHideThinkingBlock: () => boolean;
		getOutputPad: () => 0 | 1;
		getEditorPaddingX: () => number;
		getAutocompleteMaxVisible: () => number;
		getShowHardwareCursor: () => boolean;
		getClearOnShrink: () => boolean;
	};
	keybindings: { reload: () => void };
	customHeader?: unknown;
	builtInHeader?: unknown;
	editorContainer: { clear: () => void; addChild: (component: unknown) => void };
	ui: {
		setFocus: (component: unknown) => void;
		requestRender: (force?: boolean) => void;
		setShowHardwareCursor: (enabled: boolean) => void;
		setClearOnShrink: (enabled: boolean) => void;
	};
	editor: unknown;
	defaultEditor: { setPaddingX: (padding: number) => void; setAutocompleteMaxVisible: (maxVisible: number) => void };
	themeController: { applyFromSettings: () => Promise<void> };
	resetExtensionUI: () => void;
	rebuildChatFromMessages: () => void;
	setupAutocompleteProvider: () => void;
	setupExtensionShortcuts: (runner: unknown) => void;
	showLoadedResources: (options: unknown) => void;
	maybeSaveImplicitProjectTrustAfterReload: () => boolean;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	showLoadedResources(
		this: LoadedResourcesContext,
		options?: { extensions?: Array<{ path: string }>; force?: boolean; showDiagnosticsWhenQuiet?: boolean },
	): void;
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
	prepareSessionRebind(
		this: {
			session: AgentSession;
			createCurrentSessionExtensionBindings: (session: AgentSession) => ExtensionBindings;
			subscribeToAgent: (session: AgentSession) => void;
			unsubscribeFromAgent: (session: AgentSession) => void;
			applyRuntimeSettings: () => void;
			renderCurrentSessionState: () => void;
			finishCurrentSessionExtensionBinding: (session: AgentSession) => void;
			updateAvailableProviderCount: () => Promise<void>;
			updateEditorBorderColor: () => void;
			updateTerminalTitle: () => void;
			resetExtensionUI: () => void;
		},
		nextSession: AgentSession,
		previousSession: AgentSession,
	): Promise<PreparedSessionScopeRebind>;
	handleReloadCommand(this: ReloadCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type ReloadCommandContextOverrides = Omit<
	Partial<ReloadCommandContext>,
	| "runtimeHost"
	| "session"
	| "settingsManager"
	| "keybindings"
	| "editorContainer"
	| "ui"
	| "defaultEditor"
	| "themeController"
> & {
	runtimeHost?: Partial<ReloadCommandContext["runtimeHost"]>;
	session?: Partial<ReloadCommandContext["session"]>;
	settingsManager?: Partial<ReloadCommandContext["settingsManager"]>;
	keybindings?: Partial<ReloadCommandContext["keybindings"]>;
	editorContainer?: Partial<ReloadCommandContext["editorContainer"]>;
	ui?: Partial<ReloadCommandContext["ui"]>;
	defaultEditor?: Partial<ReloadCommandContext["defaultEditor"]>;
	themeController?: Partial<ReloadCommandContext["themeController"]>;
};

function createReloadCommandContext(overrides: ReloadCommandContextOverrides = {}): ReloadCommandContext {
	const editor = overrides.editor ?? {};
	return {
		hideThinkingBlock: overrides.hideThinkingBlock ?? false,
		runtimeHost: {
			reload: async (options) => {
				await options?.beforeSessionStart?.();
			},
			...overrides.runtimeHost,
		},
		session: {
			isStreaming: false,
			isCompacting: false,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			extensionRunner: {},
			modelRegistry: { getError: () => undefined },
			...overrides.session,
		},
		settingsManager: {
			getHttpIdleTimeoutMs: () => 0,
			getHideThinkingBlock: () => false,
			getOutputPad: () => 1,
			getEditorPaddingX: () => 1,
			getAutocompleteMaxVisible: () => 10,
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
			...overrides.settingsManager,
		},
		keybindings: { reload: () => {}, ...overrides.keybindings },
		editorContainer: { clear: () => {}, addChild: () => {}, ...overrides.editorContainer },
		ui: {
			setFocus: () => {},
			requestRender: () => {},
			setShowHardwareCursor: () => {},
			setClearOnShrink: () => {},
			...overrides.ui,
		},
		editor,
		defaultEditor: { setPaddingX: () => {}, setAutocompleteMaxVisible: () => {}, ...overrides.defaultEditor },
		themeController: { applyFromSettings: async () => {}, ...overrides.themeController },
		customHeader: overrides.customHeader,
		builtInHeader: overrides.builtInHeader,
		resetExtensionUI: overrides.resetExtensionUI ?? (() => {}),
		rebuildChatFromMessages: overrides.rebuildChatFromMessages ?? (() => {}),
		setupAutocompleteProvider: overrides.setupAutocompleteProvider ?? (() => {}),
		setupExtensionShortcuts: overrides.setupExtensionShortcuts ?? (() => {}),
		showLoadedResources: overrides.showLoadedResources ?? (() => {}),
		maybeSaveImplicitProjectTrustAfterReload: overrides.maybeSaveImplicitProjectTrustAfterReload ?? (() => false),
		showStatus: overrides.showStatus ?? (() => {}),
		showWarning: overrides.showWarning ?? (() => {}),
		showError: overrides.showError ?? (() => {}),
	};
}

type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" | "message_end" }>;

function getMessageText(event: MessageEvent): string {
	const message = event.message;
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function createLoadedResourcesContext(): LoadedResourcesContext {
	return {
		loadedResourcesContainer: new Container(),
		chatContainer: new Container(),
		options: { verbose: true },
		settingsManager: { getQuietStartup: () => false },
		sessionManager: { getCwd: () => "/repo" },
		session: {
			promptTemplates: [],
			resourceLoader: {
				getAgentsFiles: () => ({ agentsFiles: [{ path: "/repo/AGENTS.md" }], diagnostics: [] }),
				getSystemPromptSource: () => undefined,
				getAppendSystemPromptSources: () => [],
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getExtensions: () => ({ extensions: [], errors: [] }),
			},
			extensionRunner: {
				getCommandDiagnostics: () => [],
				getShortcutDiagnostics: () => [],
				getRegisteredCommands: () => [],
			},
		},
		getStartupExpansionState: () => false,
		formatDisplayPath: (resourcePath) => resourcePath,
		formatContextPath: (resourcePath) => resourcePath.replace("/repo/", ""),
		getBuiltInCommandConflictDiagnostics: () => [],
	};
}

describe("regression #5943: session_start transient UI", () => {
	it("renders loaded resources before restored messages without stale entries", () => {
		initTheme("dark", false);
		const context = createLoadedResourcesContext();
		const root = new Container();
		root.addChild(context.loadedResourcesContainer);
		root.addChild(context.chatContainer);
		context.loadedResourcesContainer.addChild(new Text("stale resources", 0, 0));
		context.chatContainer.addChild(new Text("restored message", 0, 0));

		interactiveModePrototype.showLoadedResources.call(context);

		const chatRendered = context.chatContainer.render(80).join("\n");
		expect(chatRendered).toContain("restored message");
		expect(chatRendered).not.toContain("[Context]");

		const rendered = root.render(80).join("\n");
		expect(rendered).not.toContain("stale resources");
		expect(rendered.indexOf("[Context]")).toBeLessThan(rendered.indexOf("restored message"));
	});

	it("renders replacement session state before session_start handlers can notify", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(agent) => {
					agent.on("session_start", (_event, ctx) => {
						ctx.ui.notify("Hello Error", "error");
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				sessionSubscriptions: new Map(),
				applyRuntimeSettings: () => events.push("apply"),
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext((message) => events.push(`notify:${message}`)),
						mode: "tui",
					});
				},
				subscribeToAgent: () => events.push("subscribe"),
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual(["apply", "render", "subscribe", "bind", "notify:Hello Error"]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the old interactive binding usable when candidate preparation fails", async () => {
		const oldPrompt = vi.fn(async () => {});
		const oldSession = { prompt: oldPrompt } as unknown as AgentSession;
		const candidateSession = {
			prepareExtensionBindings: vi.fn(async () => {
				throw new Error("candidate binding fault");
			}),
		} as unknown as AgentSession;
		const context = {
			session: oldSession,
			createCurrentSessionExtensionBindings: () => ({}),
			subscribeToAgent: vi.fn(),
			unsubscribeFromAgent: vi.fn(),
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			finishCurrentSessionExtensionBinding: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			resetExtensionUI: vi.fn(),
		};

		await expect(
			interactiveModePrototype.prepareSessionRebind.call(context, candidateSession, oldSession),
		).rejects.toThrow("candidate binding fault");
		await context.session.prompt("old binding still works");

		expect(oldPrompt).toHaveBeenCalledWith("old binding still works");
		expect(context.unsubscribeFromAgent).toHaveBeenCalledWith(candidateSession);
		expect(context.subscribeToAgent).not.toHaveBeenCalled();
	});

	it("prepares interactive subscriptions without publishing a surface-owned pointer", async () => {
		const oldSession = {} as AgentSession;
		const candidateSession = {
			prepareExtensionBindings: vi.fn(async () => {}),
			activateExtensionBindings: vi.fn(async () => {}),
		} as unknown as AgentSession;
		const context = {
			session: oldSession,
			createCurrentSessionExtensionBindings: vi.fn(() => ({})),
			subscribeToAgent: vi.fn(),
			unsubscribeFromAgent: vi.fn(),
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			finishCurrentSessionExtensionBinding: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			resetExtensionUI: vi.fn(),
		};

		const prepared = await interactiveModePrototype.prepareSessionRebind.call(
			context,
			candidateSession,
			oldSession,
		);
		expect(candidateSession.prepareExtensionBindings).toHaveBeenCalledTimes(1);
		expect(context.subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(candidateSession.activateExtensionBindings).not.toHaveBeenCalled();

		expect(() => prepared.commit()).not.toThrow();

		expect(context.session).toBe(oldSession);
		expect(candidateSession.prepareExtensionBindings).toHaveBeenCalledTimes(1);
		expect(context.subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(candidateSession.activateExtensionBindings).not.toHaveBeenCalled();
		expect(context.unsubscribeFromAgent).not.toHaveBeenCalled();
	});

	it("subscribes before replacement session_start handlers send messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(agent) => {
					agent.on("session_start", () => {
						agent.sendMessage({
							customType: "session-start",
							content: "custom from start",
							display: true,
						});
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				sessionSubscriptions: new Map(),
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual([
				"render",
				"subscribe",
				"bind",
				"message_start:custom:custom from start",
				"message_end:custom:custom from start",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("subscribes before replacement session_start handlers send user messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(agent) => {
					agent.on("session_start", () => {
						agent.sendUserMessage("user from start");
					});
				},
			],
		});
		harness.setResponses([fakeAssistantMessage("assistant from start")]);

		try {
			const context: RebindContext = {
				sessionSubscriptions: new Map(),
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });
			await harness.session.agent.waitForIdle();

			expect(events.slice(0, 3)).toEqual(["render", "subscribe", "bind"]);
			expect(events).toContain("message_start:user:user from start");
			expect(events).toContain("message_end:user:user from start");
			expect(events).toContain("message_end:assistant:assistant from start");
		} finally {
			harness.cleanup();
		}
	});

	it("runs the reload render hook before reload session_start handlers can notify", async () => {
		const events: string[] = [];
		const beforeSessionStart = vi.fn(() => {
			events.push("render");
		});
		const harness = await createHarness({
			extensionFactories: [
				(agent) => {
					agent.on("session_start", (event, ctx) => {
						events.push(`start:${event.reason}`);
						ctx.ui.notify(`notify:${event.reason}`, "error");
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				uiContext: createUiContext((message) => events.push(message)),
				mode: "tui",
			});
			expect(events).toEqual(["start:startup", "notify:startup"]);

			events.length = 0;
			await harness.session.reload({ beforeSessionStart });

			expect(beforeSessionStart).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["render", "start:reload", "notify:reload"]);
		} finally {
			harness.cleanup();
		}
	});

	it("refreshes hideThinkingBlock before rebuilding chat during reload", async () => {
		initTheme("dark", false);
		const events: string[] = [];
		let context: ReloadCommandContext;
		context = createReloadCommandContext({
			settingsManager: { getHideThinkingBlock: () => true },
			runtimeHost: {
				reload: async (options) => {
					events.push("reload");
					await options?.beforeSessionStart?.();
					events.push(`start:${context.hideThinkingBlock}`);
				},
			},
			rebuildChatFromMessages: () => {
				events.push(`rebuild:${context.hideThinkingBlock}`);
			},
		});

		await interactiveModePrototype.handleReloadCommand.call(context);

		expect(context.hideThinkingBlock).toBe(true);
		expect(events).toEqual(["reload", "rebuild:true", "start:true"]);
	});

	it("keeps the reload blocker focused until async reload completes", async () => {
		initTheme("dark", false);
		const editor = {};
		let focused: unknown;
		let chatRestored = false;
		let markReloadWaiting!: () => void;
		let finishReload!: () => void;
		const reloadWaiting = new Promise<void>((resolve) => {
			markReloadWaiting = resolve;
		});
		const reloadFinished = new Promise<void>((resolve) => {
			finishReload = resolve;
		});

		const context = createReloadCommandContext({
			editor,
			runtimeHost: {
				reload: async (options) => {
					await options?.beforeSessionStart?.();
					markReloadWaiting();
					await reloadFinished;
				},
			},
			ui: {
				setFocus: (component) => {
					focused = component;
				},
			},
			rebuildChatFromMessages: () => {
				chatRestored = true;
			},
		});

		const reloadPromise = interactiveModePrototype.handleReloadCommand.call(context);
		await reloadWaiting;

		expect(chatRestored).toBe(true);
		expect(focused).not.toBe(editor);

		finishReload();
		await reloadPromise;

		expect(focused).toBe(editor);
	});
});
