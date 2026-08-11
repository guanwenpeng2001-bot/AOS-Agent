/**
 * Prompt Customizer Extension
 *
 * Demonstrates using systemPromptOptions to make informed, context-aware
 * modifications to the system prompt without re-discovering resources.
 *
 * This extension adds tool-specific guidance based on what tools and skills
 * are currently active, respecting whatever the user has configured.
 *
 * Usage:
 * 1. Copy this file to ~/.aos-agent/agent/extensions/ or your project's .aos-agent/extensions/
 * 2. Use the extension — it automatically adapts to your active tools and skills
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "aos-agent";

/**
 * Adds tool-specific guidance that adapts to the active tool set.
 * Instead of appending one-size-fits-all instructions, this reads what's
 * actually loaded and tailors the guidance accordingly.
 */
function buildToolGuidance(options: BuildSystemPromptOptions): string | undefined {
	const hasTool = (name: string) => options.selectedTools?.includes(name) ?? false;

	const parts: string[] = [];

	if (hasTool("read")) {
		parts.push(
			"• Use the `read` tool for file contents (supports text and images).",
			"  - For large files, use `offset` and `limit` to read in chunks.",
		);
	}

	if (hasTool("bash")) {
		parts.push("• Execute commands with the `bash` tool. Use it for file operations like `ls`, `find`, `grep`.");
	}

	if (hasTool("edit")) {
		parts.push(
			"• Use the `edit` tool for precise text replacements in files. Match exact content including whitespace.",
		);
	}

	if (hasTool("write")) {
		parts.push("• Use the `write` tool to create new files or overwrite existing ones completely.");
	}

	if (options.skills && options.skills.length > 0) {
		const skillNames = options.skills.map((s) => s.name).join(", ");
		parts.push(`\nAvailable skills: ${skillNames}`, "Use skill documentation for best practices on specific tools.");
	}

	if (parts.length === 0) {
		return undefined;
	}

	return `## Tool Guidance

${parts.join("\n")}
`;
}

const extensionSpecific = `
## Extension-Added Context

This prompt includes tool guidance and skill information loaded dynamically.
User-configured prompt additions remain part of the base system prompt.
`;

export default function promptCustomizer(agent: ExtensionAPI) {
	agent.on("before_agent_start", (event) => {
		const toolGuidance = buildToolGuidance(event.systemPromptOptions);

		return {
			contribution: {
				sourceId: "example:prompt-customizer",
				label: "Dynamic tool guidance",
				visibility: "model_and_snapshot",
				systemPromptAppend: `${toolGuidance ? `${toolGuidance}\n` : ""}${extensionSpecific}`,
			},
		};
	});
}
