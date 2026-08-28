#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import ts from "typescript";
import { assertFullSha, isMain, parseFlagArguments, writeJsonAtomic } from "./line13-evidence-common.mjs";

const SHARD_PATHS = Object.freeze([
	"packages/coding-agent/test/line13-known-gap-shards/ac-01-08.ts",
	"packages/coding-agent/test/line13-known-gap-shards/ac-09-16.ts",
	"packages/coding-agent/test/line13-known-gap-shards/ac-17-24.ts",
]);

export function countLine13KnownGaps(repoRoot = process.cwd()) {
	let knownGaps = 0;
	let resolved = 0;
	for (const relativePath of SHARD_PATHS) {
		const path = resolve(repoRoot, relativePath);
		const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
		const visit = (node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				if (node.expression.text === "defineLine13KnownGapCase") knownGaps += 1;
				if (node.expression.text === "defineLine13ResolvedCase") resolved += 1;
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	if (knownGaps + resolved !== 24) {
		throw new Error(`Line 13 known-gap shards must classify all 24 criteria; found ${knownGaps + resolved}`);
	}
	return Object.freeze({ knownGaps, resolved, totalAcceptanceCriteria: 24 });
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-known-gap-count.mjs --head-sha <sha> --out <path>

Reads the three repository-owned Line 13 shard ASTs without executing test
fixtures. It emits the exact unresolved count and passes only when all 24
acceptance criteria are classified as resolved.`);
}

function main() {
	const args = parseFlagArguments(process.argv.slice(2), {
		"--head-sha": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
	const headSha = assertFullSha(args["--head-sha"]);
	if (args["--out"] === undefined) throw new Error("--out is required");
	const count = countLine13KnownGaps();
	writeJsonAtomic(args["--out"], {
		schemaVersion: 1,
		type: "known_gaps",
		headSha,
		state: count.knownGaps === 0 ? "passed" : "failed",
		count: count.knownGaps,
		totalAcceptanceCriteria: count.totalAcceptanceCriteria,
	});
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
