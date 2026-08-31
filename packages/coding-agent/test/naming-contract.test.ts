import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/public-roots.ts";

const NAMING_DIRECTORIES = [
	"packages/agent/src",
	"packages/agent/test",
	"packages/ai/src",
	"packages/ai/test",
	"packages/coding-agent/src",
	"packages/coding-agent/test",
] as const;

const sourceNamingContractPattern =
	/\b(?:(?:export|declare|default|async|abstract)\s+)*(?:type|interface|class|function|const)\s+(?<versionedDeclaration>[A-Za-z_$][\w$]*V\d+)\b|\bexport\s+(?:(?:declare|default|async|abstract)\s+)*(?:type|interface|class|function|const)\s+(?<trustedExport>Trusted[A-Z][\w$]*)|(?<lineIdentifier>\bLine13T5[\w$]*|\bLine1[0-9][\w$]*)|(?<ticket>\bT[0-9]{1,2}\b)|(?<constructionLine>\bline[- ]1[0-9]\b)|(?<deprecatedSpelling>[Ff][Aa][Uu][Xx])|(?<fixturePrefix>\b[Ll][Ii][Nn][Ee]13[-.])/gu;

const trustedNamedExportPattern =
	/\bexport\s+(?:type\s+)?\{[^}]*\b(?<trustedNamedExport>Trusted[A-Z][\w$]*)\b[^}]*\}/gu;

function maskCommentsAndStrings(source: string): string {
	const masked = source.split("");
	let quote: string | undefined;
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		const nextCharacter = source[index + 1];
		if (quote !== undefined) {
			if (character === "\\") {
				masked[index] = " ";
				index += 1;
				if (index < source.length) {
					if (source[index] !== "\r" && source[index] !== "\n") masked[index] = " ";
					index += 1;
				}
				continue;
			}
			if (character === quote) quote = undefined;
			if (character !== "\r" && character !== "\n") masked[index] = " ";
			index += 1;
			continue;
		}

		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			masked[index] = " ";
			index += 1;
			continue;
		}
		if (character === "/" && nextCharacter === "/") {
			masked[index] = " ";
			masked[index + 1] = " ";
			index += 2;
			while (index < source.length && source[index] !== "\r" && source[index] !== "\n") {
				masked[index] = " ";
				index += 1;
			}
			continue;
		}
		if (character === "/" && nextCharacter === "*") {
			masked[index] = " ";
			masked[index + 1] = " ";
			index += 2;
			while (index < source.length) {
				if (source[index] === "*" && source[index + 1] === "/") {
					masked[index] = " ";
					masked[index + 1] = " ";
					index += 2;
					break;
				}
				if (source[index] !== "\r" && source[index] !== "\n") masked[index] = " ";
				index += 1;
			}
			continue;
		}
		index += 1;
	}
	return masked.join("");
}

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

function isAllowedVersionedDeclaration(name: string): boolean {
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
		for (const directory of NAMING_DIRECTORIES) collectTypeScriptFiles(join(root, directory), files);
		files.sort();

		const violations: string[] = [];
		for (const path of files) {
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(sourceNamingContractPattern)) {
				const groups = match.groups;
				const index = match.index ?? 0;
				const location = `${relative(root, path).replaceAll("\\", "/")}:${lineNumber(source, index)}`;
				if (groups?.versionedDeclaration !== undefined && !isAllowedVersionedDeclaration(groups.versionedDeclaration)) {
					violations.push(`${location}: versioned declaration ${groups.versionedDeclaration}`);
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
				} else if (groups?.constructionLine !== undefined) {
					violations.push(`${location}: construction line ${groups.constructionLine}`);
				} else if (groups?.deprecatedSpelling !== undefined) {
					violations.push(`${location}: deprecated spelling ${groups.deprecatedSpelling}`);
				} else if (groups?.fixturePrefix !== undefined) {
					violations.push(`${location}: fixture prefix ${groups.fixturePrefix}`);
				}
			}
			for (const match of maskCommentsAndStrings(source).matchAll(trustedNamedExportPattern)) {
				const trustedNamedExport = match.groups?.trustedNamedExport;
				if (trustedNamedExport === undefined) continue;
				const index = match.index ?? 0;
				const location = `${relative(root, path).replaceAll("\\", "/")}:${lineNumber(source, index)}`;
				violations.push(`${location}: Trusted export ${trustedNamedExport}`);
			}
		}

		expect(violations).toEqual([]);
	});

	it("keeps package source imports inside published package boundaries", () => {
		const root = repoRoot();
		const packageRoot = join(root, "packages");
		const files: string[] = [];
		for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const sourceDirectory = join(packageRoot, entry.name, "src");
			if (existsSync(sourceDirectory)) collectTypeScriptFiles(sourceDirectory, files);
		}
		files.sort();

		const violations: string[] = [];
		for (const path of files) {
			const source = readFileSync(path, "utf8");
			const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
			for (const statement of sourceFile.statements) {
				if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
				const specifier = statement.moduleSpecifier;
				if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
				if (!/^(?:\.\.\/)+[a-z0-9-]+\/src\//u.test(specifier.text)) continue;
				const location = `${relative(root, path).replaceAll("\\", "/")}:${lineNumber(source, specifier.getStart(sourceFile))}`;
				violations.push(`${location}: cross-package source import ${specifier.text}`);
			}
		}

		expect(violations).toEqual([]);
	});
});
