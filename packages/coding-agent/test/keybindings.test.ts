import { describe, expect, it } from "vitest";
import { KEYBINDINGS, useWindowsKeybindings } from "../src/core/runtime/keybindings.ts";

describe("Windows keybinding defaults", () => {
	it("detects native Windows and WSL", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_INTEROP: "/run/WSL/interop" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WT_SESSION: "terminal" })).toBe(false);
	});

	it("applies the detected defaults consistently", () => {
		const windows = useWindowsKeybindings();
		expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toBe(windows ? "alt+v" : "ctrl+v");
		expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe(windows ? "ctrl+q" : "alt+enter");
		expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe(windows ? "alt+p" : "shift+ctrl+p");
	});
});
