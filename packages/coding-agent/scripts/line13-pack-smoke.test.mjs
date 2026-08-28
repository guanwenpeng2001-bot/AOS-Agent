import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import spawn from "cross-spawn";
import ts from "typescript";
import {
	assertOutsideRepository,
	assertPackageContents,
	assertPackageSmokeResult,
	createPackageSmokeResult,
} from "./line13-pack-smoke.mjs";
import { digestJson } from "./line13-evidence-common.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDirectory, "../..");
const fixturePath = join(packageDirectory, "src", "core", "external-connector-assets", "fake-connector.json");
const loaderPath = join(packageDirectory, "src", "core", "packaged-external-agent-driver.ts");
const headSha = "0123456789abcdef0123456789abcdef01234567";

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, cwd) {
	const result = spawn.sync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
		windowsHide: true,
	});
	assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
	return result.stdout;
}

function createStagedPackage(root) {
	const staged = join(root, "staged-package");
	const distCore = join(staged, "dist", "core");
	const assets = join(distCore, "external-connector-assets");
	mkdirSync(assets, { recursive: true });
	const transpiled = ts.transpileModule(readFileSync(loaderPath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			verbatimModuleSyntax: true,
		},
	});
	writeFileSync(join(distCore, "packaged-external-agent-driver.js"), transpiled.outputText);
	writeFileSync(join(distCore, "packaged-external-agent-driver.d.ts"), "export declare function loadPackagedExternalAgentDriver(name: string): unknown;\n");
	writeFileSync(
		join(staged, "dist", "external-connector.js"),
		'export { loadPackagedExternalAgentDriver, runPackagedExternalAgentDriverFixture } from "./core/packaged-external-agent-driver.js";\n',
	);
	writeFileSync(join(staged, "dist", "external-connector.d.ts"), "export * from './core/packaged-external-agent-driver.js';\n");
	copyFileSync(fixturePath, join(assets, "fake-connector.json"));
	writeFileSync(join(staged, "npm-shrinkwrap.json"), '{"name":"aos-agent","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"aos-agent","version":"1.0.0"}}}\n');
	writeFileSync(
		join(staged, "package.json"),
		`${JSON.stringify({
			name: "aos-agent",
			version: "1.0.0",
			type: "module",
			exports: {
				"./external-connector": {
					types: "./dist/external-connector.d.ts",
					import: "./dist/external-connector.js",
				},
			},
			files: ["dist", "npm-shrinkwrap.json"],
			scripts: { install: "node -e \"process.exit(91)\"" },
		}, undefined, 2)}\n`,
	);
	return staged;
}

test("package metadata owns the external Connector export and both asset copies", () => {
	const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	assert.deepEqual(packageJson.exports["./external-connector"], {
		types: "./dist/external-connector.d.ts",
		import: "./dist/external-connector.js",
	});
	assert.match(packageJson.scripts["copy-assets"], /fake-connector\.json/u);
	assert.match(packageJson.scripts["copy-binary-assets"], /fake-connector\.json/u);
	assert.ok(existsSync(fixturePath));
});

test("package-content validation catches missing public exports and assets", () => {
	const files = [
		"dist/external-connector.js",
		"dist/external-connector.d.ts",
		"dist/core/packaged-external-agent-driver.js",
		"dist/core/packaged-external-agent-driver.d.ts",
		"dist/core/external-connector-assets/fake-connector.json",
		"package.json",
		"npm-shrinkwrap.json",
	].map((path) => ({ path }));
	assert.equal(assertPackageContents({ files }).length, files.length);
	assert.throws(
		() => assertPackageContents({ files: files.filter(({ path }) => !path.endsWith("fake-connector.json")) }),
		/missing package\/dist\/core\/external-connector-assets\/fake-connector\.json/u,
	);
});

test("external npm install loads only the packed public subpath and fixture", () => {
	const root = mkdtempSync(join(tmpdir(), "aos-line13-pack-test-"));
	try {
		assertOutsideRepository(root, repoRoot);
		const staged = createStagedPackage(root);
		const packOutput = run(npmCommand(), ["pack", "--ignore-scripts", "--json", staged], root);
		const parsedPackOutput = JSON.parse(packOutput);
		const packResult = Array.isArray(parsedPackOutput)
			? parsedPackOutput[0]
			: Object.values(parsedPackOutput)[0];
		assertPackageContents(packResult);
		const install = join(root, "external-install");
		mkdirSync(install, { recursive: true });
		writeFileSync(join(install, "package.json"), '{"private":true,"type":"module"}\n');
		const tarball = join(root, packResult.filename);
		run(
			npmCommand(),
			["install", "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", tarball],
			install,
		);
		const runner = join(install, "runner.mjs");
		writeFileSync(
			runner,
			[
				'import { runPackagedExternalAgentDriverFixture } from "aos-agent/external-connector";',
				'const resolved = import.meta.resolve("aos-agent/external-connector");',
				'process.stdout.write(`${JSON.stringify({ resolved, trace: runPackagedExternalAgentDriverFixture() })}\\n`);',
				"",
			].join("\n"),
		);
		const output = JSON.parse(run(process.execPath, [runner], install));
		assert.match(output.resolved, /external-install[\\/]node_modules[\\/]aos-agent[\\/]dist[\\/]external-connector\.js$/u);
		assert.equal(output.trace.defaultEnabled, false);
		assert.equal(output.trace.networkMode, "disabled");
		assert.deepEqual(output.trace.events.map(({ kind }) => kind), ["start", "tool", "resume", "cancel"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(existsSync(root), false);
});

test("smoke-result schema records unavailable runtimes without passing them", () => {
	const runtime = (kind, state) => ({ kind, state, value: { kind, state } });
	const values = [runtime("node", "passed"), runtime("bun", "unavailable"), runtime("compiled", "not_run")];
	const result = createPackageSmokeResult({
		headSha,
		platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
		state: "failed",
		runtimes: values.map(({ kind, state, value }) => ({
			runtime: kind,
			headSha,
			state,
			digest: digestJson(value),
		})),
	});
	assert.equal(assertPackageSmokeResult(result), result);
	assert.throws(() => assertPackageSmokeResult(result, { requirePassed: true }), /runtime bun did not pass/u);
});
