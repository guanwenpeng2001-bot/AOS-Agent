import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface WhitelistEntry {
	keep: readonly string[];
}

interface PublicApiWhitelist {
	entries: Record<string, WhitelistEntry>;
}

const whitelist = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../scripts/public-api-whitelist.json", import.meta.url)), "utf8"),
) as PublicApiWhitelist;

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

describe("published API surface", () => {
	it("@aos-agent/agent-core matches its whitelist", () => {
		expect([...exportedNames("../src/index.ts")].sort()).toEqual(
			[...whitelist.entries["@aos-agent/agent-core"]!.keep].sort(),
		);
	});
});
