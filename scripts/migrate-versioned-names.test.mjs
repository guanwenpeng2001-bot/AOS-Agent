import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function writeMockExternalPackage(root) {
	const packageRoot = join(root, "node_modules/mock-versioned-package");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "mock-versioned-package", version: "1.0.0", types: "index.d.ts" }, null, "\t")}\n`);
	await writeFile(
		join(packageRoot, "index.d.ts"),
		[
			'export interface WidgetV1 { readonly source: "vendor" }',
			"export declare function createWidgetV1(): WidgetV1;",
			"",
		].join("\n"),
	);
}

function typecheckedProgram(root) {
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
	return program;
}

function assertIdentifierResolvesTo(root, relativeFileName, identifierName, lineText, expectedDeclarationFile) {
	const program = typecheckedProgram(root);
	const checker = program.getTypeChecker();
	const sourceFile = program.getSourceFile(resolve(root, relativeFileName));
	assert.notEqual(sourceFile, undefined);
	const matches = [];
	function visit(node) {
		if (ts.isIdentifier(node) && node.text === identifierName) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			if (sourceFile.text.split(/\r?\n/u)[line]?.trim() === lineText) matches.push(node);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	assert.ok(matches.length > 0, `${relativeFileName}: expected ${identifierName} on ${JSON.stringify(lineText)}`);
	for (const match of matches) {
		const direct = checker.getSymbolAtLocation(match);
		assert.notEqual(direct, undefined);
		const resolved = (direct.flags & ts.SymbolFlags.Alias) === 0 ? direct : checker.getAliasedSymbol(direct);
		assert.equal(
			resolved.declarations?.some((declaration) => resolve(declaration.getSourceFile().fileName) === resolve(root, expectedDeclarationFile)),
			true,
			`${relativeFileName}: ${identifierName} did not resolve to ${expectedDeclarationFile}`,
		);
	}
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
			`${JSON.stringify({ WidgetToolsV1: "WidgetTools", WidgetV1: "Widget", WidgetV1Schema: "WidgetSchema", createWidgetV1: "createWidget", openWidgetV1: "openWidget", parseWidgetV1: "parseWidget", serializeWidgetV1: "serializeWidget" }, null, "\t")}\n`,
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
				'export { default as openWidgetV1 } from "./open-widget.ts";',
				'export * as WidgetToolsV1 from "./widget-tools.ts";',
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
			join(root, "src/nested-parameter.ts"),
			[
				'import { createWidgetV1, type WidgetV1 } from "./index.ts";',
				"export function fromNestedParameter(createWidget: () => WidgetV1): WidgetV1 {",
				"\tvoid createWidget;",
				"\treturn createWidgetV1();",
				"}",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/catch-collision.ts"),
			[
				'import { createWidgetV1, type WidgetV1 } from "./index.ts";',
				"export function fromCatch(): WidgetV1 {",
				"\ttry {",
				"\t\tthrow createWidgetV1;",
				"\t} catch (createWidget) {",
				"\t\tvoid createWidget;",
				"\t\treturn createWidgetV1();",
				"\t}",
				"}",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/destructure-collision.ts"),
			[
				'import { createWidgetV1, type WidgetV1 } from "./index.ts";',
				"export function fromDestructure({ createWidget }: { createWidget: () => WidgetV1 }): WidgetV1 {",
				"\tvoid createWidget;",
				"\treturn createWidgetV1();",
				"}",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/block-collision.ts"),
			[
				'import { createWidgetV1, type WidgetV1 } from "./index.ts";',
				"export function fromBlock(): WidgetV1 {",
				"\tif (Date.now() > 0) {",
				'\t\tconst createWidget = () => ({ schemaVersion: 1 as const, value: "local" });',
				"\t\tvoid createWidget;",
				"\t\treturn createWidgetV1();",
				"\t}",
				"\treturn createWidgetV1();",
				"}",
				"",
			].join("\n"),
		);
		await writeFile(join(root, "src/default-widget.ts"), 'export default function createDefaultWidget() { return { schemaVersion: 1 as const, value: "default" }; }\n');
		await writeFile(join(root, "src/named-widget.ts"), 'export function createWidget() { return { schemaVersion: 1 as const, value: "named" }; }\n');
		await writeFile(join(root, "src/widget-namespace.ts"), 'export const marker = "namespace";\n');
		await writeFile(
			join(root, "src/import-collisions.ts"),
			[
				'import createWidget from "./default-widget.ts";',
				'import * as Widget from "./widget-namespace.ts";',
				'import { createWidgetV1, type WidgetV1 } from "./index.ts";',
				"export const importedWidget = createWidgetV1();",
				"export const defaultWidget = createWidget();",
				"export const namespaceMarker = Widget.marker;",
				"export type ImportedWidget = WidgetV1;",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/named-import-collision.ts"),
			[
				'import { createWidget } from "./named-widget.ts";',
				'import { createWidgetV1 } from "./index.ts";',
				"export const importedWidget = createWidgetV1();",
				"export const namedWidget = createWidget();",
				"",
			].join("\n"),
		);
		await writeFile(join(root, "src/open-widget.ts"), 'export default function () { return { schemaVersion: 1 as const, value: "open" }; }\n');
		await writeFile(join(root, "src/widget-tools.ts"), 'export const marker = "tools";\n');
		await writeFile(
			join(root, "src/mapped-import-collisions.ts"),
			[
				'import openWidgetV1 from "./open-widget.ts";',
				'import * as WidgetToolsV1 from "./widget-tools.ts";',
				'import type { WidgetV1 } from "./index.ts";',
				"export function fromMappedDefault(openWidget: () => WidgetV1): WidgetV1 {",
				"\tvoid openWidget;",
				"\treturn openWidgetV1();",
				"}",
				"export function fromMappedNamespace({ WidgetTools }: { WidgetTools: { marker: string } }): string {",
				"\tvoid WidgetTools;",
				"\treturn WidgetToolsV1.marker;",
				"}",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "src/preserved-names.ts"),
			[
				'import { createWidgetV1 } from "./index.ts";',
				"class Names {",
				'\t#createWidgetV1 = "private";',
				"\tread(): string { return this.#createWidgetV1; }",
				"}",
				"WidgetV1: { break WidgetV1; }",
				"export const preservedNames = { WidgetV1: createWidgetV1().value, names: new Names().read() };",
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
		assert.match(first.stdout, /changed files \(12\)/u);

		const source = await readFile(join(root, "src/index.ts"), "utf8");
		assert.match(source, /export interface Widget \{/u);
		assert.match(source, /export const WidgetSchema/u);
		assert.match(source, /export function parseWidget\(value: string\): Widget/u);
		assert.match(source, /export function serializeWidget\(value: Widget\): string \{/u);
		assert.match(source, /return serializeExactShape\(value\);/u);
		assert.match(source, /export \{ default as openWidget \} from "\.\/open-widget\.ts";/u);
		assert.match(source, /export \* as WidgetTools from "\.\/widget-tools\.ts";/u);
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
		typecheckedProgram(root);
		assert.equal(
			await readFile(join(root, "src/nested-parameter.ts"), "utf8"),
			[
				'import { createWidget, type Widget } from "./index.ts";',
				"export function fromNestedParameter(createWidgetLocal: () => Widget): Widget {",
				"\tvoid createWidgetLocal;",
				"\treturn createWidget();",
				"}",
				"",
			].join("\n"),
		);
		assert.match(await readFile(join(root, "src/catch-collision.ts"), "utf8"), /catch \(createWidgetLocal\)[\s\S]*return createWidget\(\);/u);
		assert.match(
			await readFile(join(root, "src/destructure-collision.ts"), "utf8"),
			/fromDestructure\(\{ createWidget: createWidgetLocal \}: \{ createWidget: \(\) => Widget \}\)[\s\S]*void createWidgetLocal;[\s\S]*return createWidget\(\);/u,
		);
		assert.match(await readFile(join(root, "src/block-collision.ts"), "utf8"), /const createWidgetLocal = [\s\S]*return createWidget\(\);/u);
		assert.equal(
			await readFile(join(root, "src/import-collisions.ts"), "utf8"),
			[
				'import createWidgetLocal from "./default-widget.ts";',
				'import * as WidgetLocal from "./widget-namespace.ts";',
				'import { createWidget, type Widget } from "./index.ts";',
				"export const importedWidget = createWidget();",
				"export const defaultWidget = createWidgetLocal();",
				"export const namespaceMarker = WidgetLocal.marker;",
				"export type ImportedWidget = Widget;",
				"",
			].join("\n"),
		);
		assert.equal(
			await readFile(join(root, "src/named-import-collision.ts"), "utf8"),
			[
				'import { createWidget as createWidgetLocal } from "./named-widget.ts";',
				'import { createWidget } from "./index.ts";',
				"export const importedWidget = createWidget();",
				"export const namedWidget = createWidgetLocal();",
				"",
			].join("\n"),
		);
		assert.match(
			await readFile(join(root, "src/mapped-import-collisions.ts"), "utf8"),
			/import openWidget from[\s\S]*import \* as WidgetTools from[\s\S]*fromMappedDefault\(openWidgetLocal:[\s\S]*return openWidget\(\);[\s\S]*fromMappedNamespace\(\{ WidgetTools: WidgetToolsLocal \}:[\s\S]*return WidgetTools\.marker;/u,
		);
		assert.equal(
			await readFile(join(root, "src/preserved-names.ts"), "utf8"),
			[
				'import { createWidget } from "./index.ts";',
				"class Names {",
				'\t#createWidgetV1 = "private";',
				"\tread(): string { return this.#createWidgetV1; }",
				"}",
				"WidgetV1: { break WidgetV1; }",
				"export const preservedNames = { WidgetV1: createWidget().value, names: new Names().read() };",
				"",
			].join("\n"),
		);
		assertIdentifierResolvesTo(root, "src/nested-parameter.ts", "createWidget", "return createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/catch-collision.ts", "createWidget", "return createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/destructure-collision.ts", "createWidget", "return createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/block-collision.ts", "createWidget", "return createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/import-collisions.ts", "createWidget", "export const importedWidget = createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/import-collisions.ts", "createWidgetLocal", "export const defaultWidget = createWidgetLocal();", "src/default-widget.ts");
		assertIdentifierResolvesTo(root, "src/import-collisions.ts", "WidgetLocal", "export const namespaceMarker = WidgetLocal.marker;", "src/widget-namespace.ts");
		assertIdentifierResolvesTo(root, "src/named-import-collision.ts", "createWidget", "export const importedWidget = createWidget();", "src/index.ts");
		assertIdentifierResolvesTo(root, "src/named-import-collision.ts", "createWidgetLocal", "export const namedWidget = createWidgetLocal();", "src/named-widget.ts");
		assertIdentifierResolvesTo(root, "src/mapped-import-collisions.ts", "openWidget", "return openWidget();", "src/open-widget.ts");
		assertIdentifierResolvesTo(root, "src/mapped-import-collisions.ts", "WidgetTools", "return WidgetTools.marker;", "src/widget-tools.ts");
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

test("preserves dependency-owned specifier keys while migrating public and local aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "aos-agent-versioned-external-names-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await writeMockExternalPackage(root);
		await writeFile(
			join(root, "tsconfig.json"),
			`${JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true }, include: ["src/**/*.ts"] }, null, "\t")}\n`,
		);
		await writeFile(join(root, "mapping.json"), `${JSON.stringify({ WidgetV1: "Widget", createWidgetV1: "createWidget" }, null, "\t")}\n`);
		const publicSource = [
			'export { createWidgetV1, createWidgetV1 as buildWidget } from "mock-versioned-package";',
			'export type { WidgetV1 } from "mock-versioned-package";',
			"",
		].join("\n");
		const directSource = [
			'import { createWidgetV1, type WidgetV1 } from "mock-versioned-package";',
			'import { createWidgetV1 as buildWidget } from "mock-versioned-package";',
			'interface Widget { readonly source: "local" }',
			'function createWidget(): Widget { return { source: "local" }; }',
			"export const importedWidget = createWidgetV1();",
			"export const builtWidget = buildWidget();",
			"export const localWidget = createWidget();",
			"export type ImportedWidget = WidgetV1;",
			"export type LocalWidget = Widget;",
			"",
		].join("\n");
		const directTypeSource = [
			'import type { WidgetV1 } from "mock-versioned-package";',
			"export type WidgetBox = { readonly value: WidgetV1 };",
			"",
		].join("\n");
		const consumerSource = [
			'import { buildWidget, createWidgetV1, type WidgetV1 } from "./index.ts";',
			"export const current = createWidgetV1();",
			"export const aliased = buildWidget();",
			"export type CurrentWidget = WidgetV1;",
			"",
		].join("\n");
		await writeFile(join(root, "src/index.ts"), publicSource);
		await writeFile(join(root, "src/direct.ts"), directSource);
		await writeFile(join(root, "src/direct-type.ts"), directTypeSource);
		await writeFile(join(root, "src/consumer.ts"), consumerSource);
		typecheckedProgram(root);

		const initialCheck = runMigration(root, true);
		assert.equal(initialCheck.status, 1, initialCheck.stderr || initialCheck.stdout);
		assert.match(initialCheck.stdout, /changed files \(4\)/u);
		assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), publicSource);
		assert.equal(await readFile(join(root, "src/direct.ts"), "utf8"), directSource);

		const first = runMigration(root);
		assert.equal(first.status, 0, first.stderr || first.stdout);
		assert.equal(first.stdout, initialCheck.stdout);
		assert.equal(
			await readFile(join(root, "src/index.ts"), "utf8"),
			[
				'export { createWidgetV1 as createWidget, createWidgetV1 as buildWidget } from "mock-versioned-package";',
				'export type { WidgetV1 as Widget } from "mock-versioned-package";',
				"",
			].join("\n"),
		);
		assert.equal(
			await readFile(join(root, "src/direct.ts"), "utf8"),
			[
				'import { createWidgetV1 as createWidget, type WidgetV1 as Widget } from "mock-versioned-package";',
				'import { createWidgetV1 as buildWidget } from "mock-versioned-package";',
				'interface WidgetLocal { readonly source: "local" }',
				'function createWidgetLocal(): WidgetLocal { return { source: "local" }; }',
				"export const importedWidget = createWidget();",
				"export const builtWidget = buildWidget();",
				"export const localWidget = createWidgetLocal();",
				"export type ImportedWidget = Widget;",
				"export type LocalWidget = WidgetLocal;",
				"",
			].join("\n"),
		);
		assert.equal(
			await readFile(join(root, "src/direct-type.ts"), "utf8"),
			[
				'import type { WidgetV1 as Widget } from "mock-versioned-package";',
				"export type WidgetBox = { readonly value: Widget };",
				"",
			].join("\n"),
		);
		assert.equal(
			await readFile(join(root, "src/consumer.ts"), "utf8"),
			[
				'import { buildWidget, createWidget, type Widget } from "./index.ts";',
				"export const current = createWidget();",
				"export const aliased = buildWidget();",
				"export type CurrentWidget = Widget;",
				"",
			].join("\n"),
		);
		typecheckedProgram(root);

		const second = runMigration(root);
		assert.equal(second.status, 0, second.stderr || second.stdout);
		assert.match(second.stdout, /changed files \(0\)/u);
		const checked = runMigration(root, true);
		assert.equal(checked.status, 0, checked.stderr || checked.stdout);
		assert.equal(checked.stdout, second.stdout);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed when a conflicting binding is exported", async () => {
	const root = await mkdtemp(join(tmpdir(), "aos-agent-versioned-name-conflict-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			join(root, "tsconfig.json"),
			`${JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src/**/*.ts"] }, null, "\t")}\n`,
		);
		await writeFile(join(root, "mapping.json"), `${JSON.stringify({ createWidgetV1: "createWidget" }, null, "\t")}\n`);
		const publicSource = 'export function createWidgetV1(): string { return "public"; }\n';
		const unsafeSource = [
			'import { createWidgetV1 } from "./index.ts";',
			'export function createWidget(): string { return "existing"; }',
			"export const result = createWidgetV1();",
			"",
		].join("\n");
		await writeFile(join(root, "src/index.ts"), publicSource);
		await writeFile(join(root, "src/unsafe.ts"), unsafeSource);

		const first = runMigration(root);
		assert.equal(first.status, 1, first.stderr || first.stdout);
		assert.match(first.stdout, /src\/unsafe\.ts:createWidget post-rename binding collision: createWidget is not a safe local binding/u);
		assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), publicSource);
		assert.equal(await readFile(join(root, "src/unsafe.ts"), "utf8"), unsafeSource);

		const second = runMigration(root);
		assert.equal(second.status, 1, second.stderr || second.stdout);
		assert.equal(second.stdout, first.stdout);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed without rewriting dependency-owned specifiers when an exported local binding conflicts", async () => {
	const root = await mkdtemp(join(tmpdir(), "aos-agent-versioned-external-conflict-"));
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await writeMockExternalPackage(root);
		await writeFile(
			join(root, "tsconfig.json"),
			`${JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true }, include: ["src/**/*.ts"] }, null, "\t")}\n`,
		);
		await writeFile(join(root, "mapping.json"), `${JSON.stringify({ createWidgetV1: "createWidget" }, null, "\t")}\n`);
		const publicSource = 'export { createWidgetV1 } from "mock-versioned-package";\n';
		const unsafeSource = [
			'import { createWidgetV1 } from "mock-versioned-package";',
			'export function createWidget(): string { return "existing"; }',
			"export const result = createWidgetV1().source;",
			"",
		].join("\n");
		await writeFile(join(root, "src/index.ts"), publicSource);
		await writeFile(join(root, "src/unsafe.ts"), unsafeSource);
		typecheckedProgram(root);

		const first = runMigration(root);
		assert.equal(first.status, 1, first.stderr || first.stdout);
		assert.match(first.stdout, /src\/unsafe\.ts:createWidget post-rename binding collision: createWidget is not a safe local binding/u);
		assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), publicSource);
		assert.equal(await readFile(join(root, "src/unsafe.ts"), "utf8"), unsafeSource);

		const checked = runMigration(root, true);
		assert.equal(checked.status, 1, checked.stderr || checked.stdout);
		assert.equal(checked.stdout, first.stdout);
		assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), publicSource);
		assert.equal(await readFile(join(root, "src/unsafe.ts"), "utf8"), unsafeSource);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
