import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/public-roots.ts";

const SOURCE_DIRECTORIES = ["packages/agent/src", "packages/coding-agent/src", "packages/ai/src"] as const;

const sourceNamingContractPattern =
	/\bexport\s+(?:(?:declare|default|async)\s+)*(?:type|interface|class|function|const)\s+(?<versionedExport>[A-Za-z_$][\w$]*V\d+)\b|\bexport\s+(?:(?:declare|default|async)\s+)*(?:type|interface|class|function|const)\s+(?<trustedExport>Trusted[A-Z][\w$]*)|(?<lineIdentifier>\bLine13T5[\w$]*|\bLine1[0-9][\w$]*)|(?<ticket>\bT[0-9]{1,2}\b)|(?<faux>[Ff][Aa][Uu][Xx])|(?<fixturePrefix>\b[Ll][Ii][Nn][Ee]13[-.])/gu;

function collectTypeScriptFiles(directory: string, files: string[]): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) collectTypeScriptFiles(path, files);
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
}

function lineNumber(source: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor++) {
		if (source[cursor] === "\n") line += 1;
	}
	return line;
}

function isUrlTerminator(character: string | undefined): boolean {
	return character === undefined || " \t\r\n\"'`<>[]{}(),;".includes(character);
}

function isInsideUrl(source: string, index: number): boolean {
	const lineStart = source.lastIndexOf("\n", index - 1) + 1;
	const lineEnd = source.indexOf("\n", index);
	const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
	const offset = index - lineStart;
	for (const scheme of ["http://", "https://"]) {
		const schemeStart = line.lastIndexOf(scheme, offset);
		if (schemeStart === -1) continue;
		let end = schemeStart + scheme.length;
		while (!isUrlTerminator(line[end])) end += 1;
		if (offset >= schemeStart && offset < end) return true;
	}
	return false;
}

function isDiskSchemaField(source: string, index: number, tokenLength: number): boolean {
	const lineStart = source.lastIndexOf("\n", index - 1) + 1;
	const lineEnd = source.indexOf("\n", index);
	const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
	const offset = index - lineStart;
	let cursor = offset + tokenLength;
	while (cursor < line.length && line[cursor] === " ") cursor += 1;
	const lowerLine = line.toLowerCase();
	return line[cursor] === ":" && (lowerLine.includes("schema") || lowerLine.includes("disk"));
}

function isAllowedVersionedExport(name: string): boolean {
	return (
		name === "JsonlV4Header" ||
		name === "JsonlV5Header" ||
		(name.startsWith("decodeLegacy") && name.endsWith("V1")) ||
		(name.startsWith("planLegacy") && name.endsWith("MigrationV1"))
	);
}

describe("source naming contract", () => {
	it("keeps all package source names free of retired naming patterns", () => {
		const root = repoRoot();
		const files: string[] = [];
		for (const directory of SOURCE_DIRECTORIES) collectTypeScriptFiles(join(root, directory), files);
		files.sort();

		const violations: string[] = [];
		for (const path of files) {
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(sourceNamingContractPattern)) {
				const groups = match.groups;
				const index = match.index ?? 0;
				const location = `${relative(root, path).replaceAll("\\", "/")}:${lineNumber(source, index)}`;
				if (groups?.versionedExport !== undefined && !isAllowedVersionedExport(groups.versionedExport)) {
					violations.push(`${location}: versioned export ${groups.versionedExport}`);
				} else if (groups?.trustedExport !== undefined) {
					violations.push(`${location}: Trusted export ${groups.trustedExport}`);
				} else if (groups?.lineIdentifier !== undefined) {
					violations.push(`${location}: line identifier ${groups.lineIdentifier}`);
				} else if (
					groups?.ticket !== undefined &&
					!isInsideUrl(source, index) &&
					!isDiskSchemaField(source, index, groups.ticket.length)
				) {
					violations.push(`${location}: ticket marker ${groups.ticket}`);
				} else if (groups?.faux !== undefined) {
					violations.push(`${location}: faux naming ${groups.faux}`);
				} else if (groups?.fixturePrefix !== undefined) {
					violations.push(`${location}: fixture prefix ${groups.fixturePrefix}`);
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
