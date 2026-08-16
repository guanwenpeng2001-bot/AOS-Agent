import { Container, type Focusable, getKeybindings, Spacer, Text, type TUI } from "@aos-agent/tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * Transient dialog for the interactive MCP OAuth flow.
 *
 * Shows the one-time authorization URL (surfaced exactly once through the
 * `AuthInteraction.notify` `auth_url` event), waits for the browser callback,
 * and aborts the flow when the user presses the cancel key. The URL is only
 * ever displayed inside this dialog instance; it is never written to the
 * transcript, status, or any other surface.
 */
export class McpAuthDialogComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly contentContainer: Container;
	private readonly abortController = new AbortController();
	private readonly onComplete: (success: boolean, message?: string) => void;

	// Focusable implementation - propagate to content for key handling.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		tui: TUI,
		serverId: string,
		onComplete: (success: boolean, message?: string) => void,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const title = titleOverride ?? `Authorize MCP server ${serverId}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/**
	 * Displays the one-time authorization URL and waits. Callers must not
	 * retain or re-display the URL anywhere else.
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", "Waiting for the browser callback..."), 1, 0));
		this.contentContainer.addChild(
			new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0),
		);

		this.tui.requestRender();
	}

	/** Show an informational progress line (non-blocking). */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	/** Aborts the flow. Idempotent. */
	cancel(): void {
		if (this.abortController.signal.aborted) {
			return;
		}
		this.abortController.abort();
		this.onComplete(false, "MCP OAuth cancelled");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
	}
}
