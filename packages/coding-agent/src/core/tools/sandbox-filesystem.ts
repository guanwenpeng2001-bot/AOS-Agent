import { PolicyError } from "../execution-policy.ts";
import type { SandboxDirectoryEntry, SandboxOperationResult } from "../sandbox.ts";

export function sandboxContentBuffer(result: SandboxOperationResult, operation: string): Buffer {
	const content = result.content;
	if (content === undefined) {
		throw new PolicyError("policy_violation", `Sandbox provider did not return content for ${operation}.`);
	}
	return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

export function sandboxContentText(result: SandboxOperationResult, operation: string): string {
	return sandboxContentBuffer(result, operation).toString("utf-8");
}

function sandboxOptionalText(value: Buffer | string | undefined): string {
	if (value === undefined) return "";
	return Buffer.isBuffer(value) ? value.toString("utf-8") : value;
}

export function sandboxProcessOutputText(
	result: SandboxOperationResult,
	streamedOutput: string,
): { readonly stdout: string; readonly stderr: string } {
	const returnedStdout = `${sandboxOptionalText(result.stdout)}${sandboxOptionalText(result.content)}`;
	return {
		stdout: streamedOutput.length > 0 ? `${streamedOutput}${sandboxOptionalText(result.stdout)}` : returnedStdout,
		stderr: sandboxOptionalText(result.stderr),
	};
}

export function sandboxEntries(
	result: SandboxOperationResult,
	operation: string,
): ReadonlyArray<string | SandboxDirectoryEntry> {
	if (result.entries === undefined) {
		throw new PolicyError("policy_violation", `Sandbox provider did not return entries for ${operation}.`);
	}
	return result.entries;
}

export function sandboxEntryName(entry: string | SandboxDirectoryEntry): string {
	return typeof entry === "string" ? entry : entry.name;
}

export function sandboxEntryIsDirectory(entry: string | SandboxDirectoryEntry): boolean {
	return typeof entry !== "string" && entry.isDirectory === true;
}
