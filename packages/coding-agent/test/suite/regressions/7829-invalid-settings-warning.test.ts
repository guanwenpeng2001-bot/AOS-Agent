import { Container } from "@aos-agent/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

describe("issue #7829 startup diagnostics", () => {
	beforeAll(() => initTheme("dark"));

	it("renders a settings warning in the transcript", () => {
		const chatContainer = new Container();
		const showWarning = Reflect.get(InteractiveMode.prototype, "showWarning") as (this: unknown, message: string) => void;
		showWarning.call({ chatContainer, outputPad: 1, ui: { requestRender: vi.fn() } }, "Invalid settings file settings.json");

		expect(chatContainer.render(120).join("\n")).toContain("Warning: Invalid settings file settings.json");
	});
});
