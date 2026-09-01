import { Container, type TUI } from "@aos-agent/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type UpdateThinkingVisibility = (this: { chatContainer: Container; ui: TUI }) => void;
type ToggleThinkingVisibility = (this: {
	hideThinkingBlock: boolean;
	settingsManager: { setHideThinkingBlock(hidden: boolean): void };
	updateThinkingBlockVisibility(): void;
	showStatus(message: string): void;
}) => void;

describe("issue #8611 thinking visibility with pending Bash output", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps the live tool component and its partial output", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const tool = new ToolExecutionComponent(
			"bash",
			"tool-8611",
			{ command: "echo first; sleep 10" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		chatContainer.addChild(tool);

		const update = Reflect.get(InteractiveMode.prototype, "updateThinkingBlockVisibility") as UpdateThinkingVisibility;
		const toggle = Reflect.get(InteractiveMode.prototype, "toggleThinkingBlockVisibility") as ToggleThinkingVisibility;
		const mode = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			chatContainer,
			ui,
			updateThinkingBlockVisibility() {
				update.call(this);
			},
			showStatus: vi.fn(),
		};

		toggle.call(mode);

		expect(chatContainer.children).toContain(tool);
		expect(stripAnsi(chatContainer.render(120).join("\n"))).toContain("first");
	});
});
