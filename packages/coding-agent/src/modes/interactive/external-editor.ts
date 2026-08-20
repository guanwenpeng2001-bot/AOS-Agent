import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "../../utils/child-process.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

function splitEditorCommand(command: string): string[] {
	const parts: string[] = [];
	let part = "";
	let quote: '"' | "'" | undefined;

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else if (character === "\\" && command[index + 1] === quote) {
				part += command[++index];
			} else {
				part += character;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			if (part) {
				parts.push(part);
				part = "";
			}
		} else {
			part += character;
		}
	}
	if (part) parts.push(part);
	return parts;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "aos-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const commandParts = splitEditorCommand(options.command);
		if (process.platform === "win32" && commandParts.length > 1 && /^[a-z]:[\\/]/i.test(commandParts[0])) {
			while (commandParts.length > 1 && !existsSync(commandParts[0])) {
				commandParts[0] += ` ${commandParts.splice(1, 1)[0]}`;
			}
		}
		const [editor, ...editorArgs] = commandParts;
		if (!editor) return { status: "failed" };
		process.stdout.write(`Launching external editor: ${options.command}\nAOS Agent will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawnProcess(editor, [...editorArgs, filePath], {
				stdio: "inherit",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: readFileSync(filePath, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
