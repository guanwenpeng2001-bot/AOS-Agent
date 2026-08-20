import type { FileError, Result } from "../../types.ts";
import { SessionError } from "../types.ts";

export class JsonlDecodeError extends Error {
	readonly kind: "syntax" | "schema";

	constructor(kind: "syntax" | "schema", message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlDecodeError";
		this.kind = kind;
	}
}

/** True only when a final JSON line is structurally incomplete, not merely invalid. */
export function isTruncatedJsonLine(line: string): boolean {
	const text = line.trim();
	if (!text.startsWith("{") && !text.startsWith("[")) return false;
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (const character of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") stack.push(character);
		else if (character === "}" || character === "]") {
			const opening = stack.pop();
			if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) return false;
		}
	}
	return inString || escaped || stack.length > 0;
}

export function fileResult<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		throw new SessionError(
			result.error.code === "not_found" ? "not_found" : "storage",
			`${message}: ${result.error.message}`,
			result.error,
		);
	}
	return result.value;
}

export function invalidFile(path: string, line: number, cause: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL v4 session ${path}: line ${line} ${cause.message}`, cause);
}
