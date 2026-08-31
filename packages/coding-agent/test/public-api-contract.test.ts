import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface WhitelistEntry {
	keep: readonly string[];
	docs: readonly string[];
}

interface PublicApiWhitelist {
	entries: Record<string, WhitelistEntry>;
}

const whitelist = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../scripts/public-api-whitelist.json", import.meta.url)), "utf8"),
) as PublicApiWhitelist;

const entrySources = {
	".": "../src/index.ts",
	"./client": "../src/client/index.ts",
	"./external-connector": "../src/external-connector.ts",
	"./external-connector/testing": "../src/external-connector-testing.ts",
	"./rpc-entry": "../src/rpc-entry.ts",
} as const;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasDocumentedName(document: string, name: string): boolean {
	return new RegExp(`(?<![$\\w])${escapeRegExp(name)}(?![$\\w])`, "u").test(document);
}

function exportedNames(relativePath: string): readonly string[] {
	const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url));
	const program = ts.createProgram({
		rootNames: [sourcePath],
		options: {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ESNext,
		},
	});
	const source = program.getSourceFile(sourcePath);
	const checker = program.getTypeChecker();
	const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
	return symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((entry) => entry.name);
}

describe("published API contract", () => {
	for (const [entry, source] of Object.entries(entrySources)) {
		it(`${entry} matches its whitelist`, () => {
			expect([...exportedNames(source)].sort()).toEqual([...whitelist.entries[entry]!.keep].sort());
		});
	}

	it("has documentation evidence for every kept export", () => {
		for (const [entry, contract] of Object.entries(whitelist.entries)) {
			if (contract.keep.length === 0) continue;
			expect(contract.docs, `${entry} must declare documentation evidence`).not.toHaveLength(0);
			const documents = contract.docs.map((path) => {
				expect(path, `${entry} has invalid documentation evidence: ${path}`).toMatch(
					/(?:^|\/)README\.md$|(?:^|\/)docs\/|(?:^|\/)examples\//u,
				);
				return readFileSync(resolve(repoRoot, path), "utf8");
			});
			for (const name of contract.keep) {
				expect(
					documents.some((document) => hasDocumentedName(document, name)),
					`${entry} keep item ${name} has no docs/README/examples evidence`,
				).toBe(true);
			}
		}
	});
});
