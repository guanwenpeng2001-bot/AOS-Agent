import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const migrationScript = fileURLToPath(new URL("./migrate-versioned-names.mjs", import.meta.url));

function runMigration(root, check = false) {
	return spawnSync(
		process.execPath,
		[
			migrationScript,
			`--root=${root}`,
			"--public-root=src/index.ts",
			`--mapping=${join(root, "mapping.json")}`,
			...(check ? ["--check"] : []),
		],
		{ cwd: root, encoding: "utf8" },
	);
}

function typecheck(root) {
	const configPath = join(root, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	assert.equal(config.error, undefined, config.error === undefined ? undefined : ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true }, configPath);
	const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	assert.deepEqual(
		diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
		[],
	);
}

test("migrates reviewed symbols once and then passes an idempotent check", async () => {
	const root = await mkdtemp(join(tmpdir(), "aos-agent-versioned-names-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			join(root, "tsconfig.json"),
			`${JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src/**/*.ts"] }, null, "\t")}\n`,
		);
		await writeFile(
			join(root, "mapping.json"),
			`${JSON.stringify({ WidgetV1: "Widget", WidgetV1Schema: "WidgetSchema", createWidgetV1: "createWidget", parseWidgetV1: "parseWidget", serializeWidgetV1: "serializeWidget" }, null, "\t")}\n`,
		);
		await writeFile(
			join(root, "src/index.ts"),
			[
				"export interface WidgetV1 { readonly schemaVersion: 1; readonly value: string }",
				"export type Widget = WidgetV1;",
				"export const WidgetV1Schema = { schemaVersion: 1 } as const;",
				"export function createWidgetV1(): WidgetV1 {",
				'\treturn { schemaVersion: 1, value: "imported" };',
				"}",
				"export function parseWidgetV1(value: string): WidgetV1 {",
				'\treturn { schemaVersion: 1, value };',
				"}",
				"function serializeExactShape(value: WidgetV1): string {",
				"\treturn JSON.stringify(value);",
				"}",
				"export function serializeWidgetV1(value: WidgetV1): string {",
				"\treturn serializeExactShape(value);",
				"}",
				'export type { ArchiveFile } from "./history.ts";',
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/collision.ts"),
			[
				'import { createWidgetV1 } from "./index.ts";',
				"function createWidget() {",
				"\treturn createWidgetV1();",
				"}",
				"export const widget = createWidget();",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/history.ts"),
			[
				"export interface ArchiveV4 { readonly version: 4 }",
				"export interface ArchiveV5 { readonly version: 5 }",
				"export type ArchiveFile = ArchiveV4 | ArchiveV5;",
				"",
			].join("\n"),
		);
		await writeFile(join(root, "README.md"), "Use `WidgetV1`, `WidgetV1Schema`, and `parseWidgetV1`.\n");
		await writeFile(
			join(root, "CHANGELOG.md"),
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"- Use `WidgetV1`.",
				"",
				"## [1.0.0]",
				"",
				"- Published `WidgetV1`.",
				"",
			].join("\n"),
		);

		const first = runMigration(root);
		assert.equal(first.status, 0, first.stderr || first.stdout);
		assert.match(first.stdout, /WidgetV1 -> Widget/u);
		assert.match(first.stdout, /conflicts \(0\)/u);
		assert.match(first.stdout, /unresolved references \(0\)/u);
		assert.match(first.stdout, /changed files \(4\)/u);

		const source = await readFile(join(root, "src/index.ts"), "utf8");
		assert.match(source, /export interface Widget \{/u);
		assert.match(source, /export const WidgetSchema/u);
		assert.match(source, /export function parseWidget\(value: string\): Widget/u);
		assert.match(source, /export function serializeWidget\(value: Widget\): string \{/u);
		assert.match(source, /return serializeExactShape\(value\);/u);
		assert.doesNotMatch(source, /\bWidgetV1\b|\bWidgetV1Schema\b|\bparseWidgetV1\b|\bserializeWidgetV1\b/u);
		assert.equal(
			await readFile(join(root, "src/collision.ts"), "utf8"),
			[
				'import { createWidget } from "./index.ts";',
				"function createWidgetLocal() {",
				"\treturn createWidget();",
				"}",
				"export const widget = createWidgetLocal();",
				"",
			].join("\n"),
		);
		typecheck(root);
		assert.equal(
			await readFile(join(root, "src/history.ts"), "utf8"),
			[
				"export interface ArchiveV4 { readonly version: 4 }",
				"export interface ArchiveV5 { readonly version: 5 }",
				"export type ArchiveFile = ArchiveV4 | ArchiveV5;",
				"",
			].join("\n"),
		);
		assert.equal(await readFile(join(root, "README.md"), "utf8"), "Use `Widget`, `WidgetSchema`, and `parseWidget`.\n");
		assert.equal(
			await readFile(join(root, "CHANGELOG.md"), "utf8"),
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"- Use `Widget`.",
				"",
				"## [1.0.0]",
				"",
				"- Published `WidgetV1`.",
				"",
			].join("\n"),
		);

		const second = runMigration(root);
		assert.equal(second.status, 0, second.stderr || second.stdout);
		assert.match(second.stdout, /changed files \(0\)/u);

		const checked = runMigration(root, true);
		assert.equal(checked.status, 0, checked.stderr || checked.stdout);
		assert.match(checked.stdout, /changed files \(0\)/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
