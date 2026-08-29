#!/usr/bin/env node

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_MAPPING_PATH = path.join(SCRIPT_DIR, "pr-08-core-mapping.json");
const SCAN_ROOTS = ["packages", "scripts", "examples", "docs"];
const TEXT_EXTENSIONS = new Set([
	".cjs", ".cts", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".mts",
	".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const ARTIFACT_NAMES = new Set([
	"pr-08-core-mapping.json",
	"pr-08-core-mapping.md",
	"rewrite-pr08-imports.mjs",
]);
const DOMAINS = new Set([
	"connector", "scheduler", "subagent", "worker", "session", "policy", "runtime", "migrations", "cross-domain",
]);

function usage(message) {
	if (message !== undefined) console.error(message);
	console.error("Usage: node scripts/migrations/rewrite-pr08-imports.mjs (--domain <name> | --all) [--dry-run] [--mapping <path>] [--root <path>]");
	process.exitCode = 2;
}

function parseArgs(argv) {
	let all = false;
	let domain;
	let dryRun = false;
	let mappingPath = DEFAULT_MAPPING_PATH;
	let repoRoot = DEFAULT_REPO_ROOT;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--all") all = true;
		else if (argument === "--dry-run") dryRun = true;
		else if (argument === "--domain") domain = argv[++index];
		else if (argument === "--mapping") mappingPath = path.resolve(argv[++index] ?? "");
		else if (argument === "--root") repoRoot = path.resolve(argv[++index] ?? "");
		else return undefined;
	}
	if (all === (domain !== undefined)) return undefined;
	if (domain !== undefined && !DOMAINS.has(domain)) return undefined;
	return { all, domain, dryRun, mappingPath, repoRoot };
}

function posix(value) {
	return value.replaceAll("\\", "/");
}

async function exists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function collectFiles(root) {
	if (!await exists(root)) return [];
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const target = path.join(root, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) files.push(...await collectFiles(target));
		else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
	}
	return files;
}

function validateMapping(value) {
	if (!Array.isArray(value)) throw new Error("PR-08 mapping must be an array");
	const fromPaths = new Set();
	for (const row of value) {
		if (
			typeof row !== "object" || row === null ||
			typeof row.from !== "string" || typeof row.to !== "string" ||
			typeof row.domain !== "string" || typeof row.reason !== "string" ||
			!DOMAINS.has(row.domain) || path.isAbsolute(row.from) || path.isAbsolute(row.to) ||
			row.from.includes("\\") || row.to.includes("\\")
		) throw new Error(`Invalid PR-08 mapping row: ${JSON.stringify(row)}`);
		if (fromPaths.has(row.from)) throw new Error(`Duplicate PR-08 source path: ${row.from}`);
		fromPaths.add(row.from);
	}
	return value;
}

function pathCandidates(value) {
	const candidates = [value];
	const extension = path.posix.extname(value);
	if (extension === "") {
		for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(`${value}${sourceExtension}`);
		for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(`${value}/index${sourceExtension}`);
	} else if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
		const stem = value.slice(0, -extension.length);
		for (const sourceExtension of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(`${stem}${sourceExtension}`);
	}
	return candidates;
}

function preserveSpecifierExtension(target, source, specifier) {
	const specifierExtension = path.posix.extname(specifier);
	const sourceExtension = path.posix.extname(source);
	const targetExtension = path.posix.extname(target);
	if (specifierExtension === "" && sourceExtension !== "" && target.endsWith(targetExtension)) {
		return target.slice(0, -targetExtension.length);
	}
	if (specifierExtension !== "" && specifierExtension !== sourceExtension && targetExtension === sourceExtension) {
		return `${target.slice(0, -targetExtension.length)}${specifierExtension}`;
	}
	return target;
}

function relativeSpecifier(importer, target, source, originalSpecifier) {
	let relative = posix(path.relative(path.dirname(importer), target));
	relative = preserveSpecifierExtension(relative, source, originalSpecifier);
	if (!relative.startsWith(".")) relative = `./${relative}`;
	return relative;
}

function changelogEditablePrefix(text, file) {
	if (path.basename(file).toLowerCase() !== "changelog.md") return text.length;
	const released = /^## (?!\[Unreleased\])/m.exec(text);
	return released?.index ?? text.length;
}

const options = parseArgs(process.argv.slice(2));
if (options === undefined) {
	usage("Choose exactly one of --domain <name> or --all and provide values for path options.");
} else {
	const mapping = validateMapping(JSON.parse(await readFile(options.mappingPath, "utf8")));
	const selected = new Set(mapping.filter((row) => options.all || row.domain === options.domain));
	const state = new Map();
	for (const row of mapping) {
		if (row.from === row.to) {
			state.set(row, false);
			continue;
		}
		const fromExists = await exists(path.join(options.repoRoot, row.from));
		const toExists = await exists(path.join(options.repoRoot, row.to));
		if (selected.has(row) && fromExists && toExists && !row.from.endsWith("/")) {
			throw new Error(`Selected PR-08 move is ambiguous because both paths exist: ${row.from}`);
		}
		state.set(row, toExists && !fromExists);
	}

	const fileRows = mapping.filter((row) => !row.from.endsWith("/"));
	const directoryRows = mapping.filter((row) => row.from.endsWith("/")).sort((left, right) => right.from.length - left.from.length);
	const sourceRows = new Map(fileRows.map((row) => [row.from, row]));
	const currentRows = new Map(fileRows.map((row) => [state.get(row) ? row.to : row.from, row]));
	const movedSelectedRows = new Set(fileRows.filter((row) => selected.has(row) && state.get(row)));
	const selectedImporters = new Map(fileRows.filter((row) => movedSelectedRows.has(row)).map((row) => [row.to, row]));

	function exactRow(resolved, rows) {
		for (const candidate of pathCandidates(resolved)) {
			const row = rows.get(candidate);
			if (row !== undefined) return { row, matched: candidate };
		}
		return undefined;
	}

	function sourceRow(resolved) {
		const exact = exactRow(resolved, sourceRows);
		if (exact !== undefined) return exact;
		for (const row of directoryRows) {
			const prefix = row.from.slice(0, -1);
			if (resolved === prefix || resolved.startsWith(row.from)) return { row, matched: resolved };
		}
		return undefined;
	}

	function currentRow(resolved) {
		return exactRow(resolved, currentRows);
	}

	function currentTarget(match) {
		const { row, matched } = match;
		const base = state.get(row) ? row.to : row.from;
		if (!row.from.endsWith("/")) return base;
		const suffix = matched.slice(row.from.length);
		return `${base}${suffix}`;
	}

	function rewriteRelative(value, repoFile) {
		const suffixMatch = /([?#].*)$/.exec(value);
		const suffix = suffixMatch?.[1] ?? "";
		const specifier = suffix === "" ? value : value.slice(0, -suffix.length);
		const repoImporter = posix(path.relative(options.repoRoot, repoFile));
		const actualResolved = posix(path.normalize(path.join(path.dirname(repoImporter), specifier)));
		if (currentRow(actualResolved) !== undefined) return value;

		const direct = sourceRow(actualResolved);
		if (direct !== undefined && selected.has(direct.row) && state.get(direct.row)) {
			const target = currentTarget(direct);
			return `${relativeSpecifier(repoImporter, target, direct.matched, specifier)}${suffix}`;
		}

		const importerRow = selectedImporters.get(repoImporter);
		if (importerRow === undefined) return value;
		const originalResolved = posix(path.normalize(path.join(path.dirname(importerRow.from), specifier)));
		const originalTarget = sourceRow(originalResolved);
		if (originalTarget === undefined) return value;
		const target = currentTarget(originalTarget);
		return `${relativeSpecifier(repoImporter, target, originalTarget.matched, specifier)}${suffix}`;
	}

	const explicitReplacements = mapping
		.filter((row) => selected.has(row) && state.get(row))
		.flatMap((row) => {
			const replacements = [[row.from, row.to]];
			const packagePrefix = "packages/coding-agent/";
			if (row.from.startsWith(packagePrefix) && row.to.startsWith(packagePrefix)) {
				replacements.push([row.from.slice(packagePrefix.length), row.to.slice(packagePrefix.length)]);
			}
			return replacements;
		})
		.sort((left, right) => right[0].length - left[0].length);

	function rewriteLiteral(value, repoFile) {
		if (value.includes("${")) return value;
		if (value.startsWith("./") || value.startsWith("../")) return rewriteRelative(value, repoFile);
		let rewritten = value;
		for (const [from, to] of explicitReplacements) rewritten = rewritten.replaceAll(from, to);
		return rewritten;
	}

	const scanFiles = (await Promise.all(SCAN_ROOTS.map((root) => collectFiles(path.join(options.repoRoot, root))))).flat();
	const changed = [];
	for (const file of scanFiles) {
		if (ARTIFACT_NAMES.has(path.basename(file))) continue;
		const original = await readFile(file, "utf8");
		if (original.includes("\0")) continue;
		const editablePrefix = changelogEditablePrefix(original, file);
		const head = original.slice(0, editablePrefix);
		const tail = original.slice(editablePrefix);
		const rewritten = head.replace(/(["'`])([^"'`\r\n]+)\1/g, (literal, quote, value) => {
			const next = rewriteLiteral(value, file);
			return next === value ? literal : `${quote}${next}${quote}`;
		}) + tail;
		if (rewritten === original) continue;
		changed.push(posix(path.relative(options.repoRoot, file)));
		if (!options.dryRun) await writeFile(file, rewritten);
	}

	const mode = options.dryRun ? "Would rewrite" : "Rewrote";
	console.log(`${mode} ${changed.length} file${changed.length === 1 ? "" : "s"}.`);
	for (const file of changed) console.log(file);
}
