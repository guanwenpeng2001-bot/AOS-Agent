import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import spawn from "cross-spawn";
import ts from "typescript";
import {
	assertOutsideRepository,
	assertPackageContents,
	assertPackageSmokeResult,
	createPackageSmokeResult,
	PACKAGED_FIXTURE_TOOL_CALL_ID,
	runInstalledBootSmokes,
} from "./pack-smoke.mjs";
import { digestJson } from "./pack-smoke-common.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDirectory, "../..");
const fixturePath = join(packageDirectory, "src", "core", "connector", "assets", "fake-connector.json");
const processModulePath = join(
	packageDirectory,
	"src",
	"core",
	"connector",
	"assets",
	"fake-connector-process.mjs",
);
const loaderPath = join(packageDirectory, "src", "core", "connector", "packaged-driver.ts");
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

function assertExecutedTrace(trace) {
	assert.equal(PACKAGED_FIXTURE_TOOL_CALL_ID, "aos.fake-tool-call");
	assert.equal(trace.defaultEnabled, false);
	assert.equal(trace.networkMode, "disabled");
	assert.deepEqual(trace.events.map(({ kind }) => kind), [
		"capabilities",
		"start",
		"tool",
		"resume",
		"cancel",
	]);
	assert.deepEqual(trace.receipts.map(({ phase, status }) => ({ phase, status })), [
		{ phase: "run", status: "suspended" },
		{ phase: "resume", status: "succeeded" },
		{ phase: "cancel", status: "cancelled" },
	]);
	assert.deepEqual(trace.toolResult, {
		toolCallId: PACKAGED_FIXTURE_TOOL_CALL_ID,
		toolName: "fixture.echo",
		ok: true,
		sideEffectState: "none",
		output: "echo:deterministic",
	});
	assert.deepEqual(trace.lifecycle, {
		capabilities: 1,
		probeCapabilities: 1,
		createAttempt: 2,
		runAttempt: 1,
		tool: 1,
		resumeAttempt: 1,
		cancelAttempt: 1,
		reconcileAttempt: 1,
		dispose: 1,
	});
}

function createStagedPackage(root) {
	const staged = join(root, "staged-package");
	const distCore = join(staged, "dist", "core");
	const distConnector = join(distCore, "connector");
	const assets = join(distConnector, "assets");
	mkdirSync(assets, { recursive: true });
	writeFileSync(
		join(staged, "dist", "cli.js"),
		[
			"#!/usr/bin/env node",
			'const supported = new Set(["--version", "--help", "--list-models"]);',
			"if (process.argv.length !== 3 || !supported.has(process.argv[2])) process.exitCode = 2;",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	writeFileSync(
		join(staged, "dist", "index.js"),
		"export async function createAgentSession() { return { session: { dispose() {} } }; }\n",
	);
	writeFileSync(
		join(staged, "dist", "index.d.ts"),
		"export declare function createAgentSession(options?: unknown): Promise<{ session: { dispose(): void } }>;\n",
	);
	const transpiled = ts.transpileModule(readFileSync(loaderPath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			verbatimModuleSyntax: true,
		},
	});
	writeFileSync(join(distConnector, "packaged-driver.js"), transpiled.outputText);
	writeFileSync(
		join(distConnector, "packaged-driver.d.ts"),
		"export declare function loadPackagedExternalAgentDriver(name: string): unknown;\nexport declare function runPackagedExternalAgentDriverFixture(): Promise<unknown>;\n",
	);
	writeFileSync(
		join(staged, "dist", "external-connector.js"),
		'export { loadPackagedExternalAgentDriver, runPackagedExternalAgentDriverFixture } from "./core/connector/packaged-driver.js";\n',
	);
	writeFileSync(join(staged, "dist", "external-connector.d.ts"), "export * from './core/connector/packaged-driver.js';\n");
	copyFileSync(fixturePath, join(assets, "fake-connector.json"));
	copyFileSync(processModulePath, join(assets, "fake-connector-process.mjs"));
	writeFileSync(join(staged, "npm-shrinkwrap.json"), '{"name":"aos-agent","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"aos-agent","version":"1.0.0"}}}\n');
	writeFileSync(
		join(staged, "package.json"),
		`${JSON.stringify({
			name: "aos-agent",
			version: "1.0.0",
			type: "module",
			bin: { aos: "dist/cli.js" },
			exports: {
				".": {
					types: "./dist/index.d.ts",
					import: "./dist/index.js",
				},
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

test("package metadata owns the CLI, SDK, external Connector export, and both asset copies", () => {
	const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	assert.equal(packageJson.bin.aos, "dist/cli.js");
	assert.deepEqual(packageJson.exports["."], {
		types: "./dist/index.d.ts",
		import: "./dist/index.js",
	});
	assert.deepEqual(packageJson.exports["./external-connector"], {
		types: "./dist/external-connector.d.ts",
		import: "./dist/external-connector.js",
	});
	assert.match(packageJson.scripts["copy-assets"], /fake-connector\.json/u);
	assert.match(packageJson.scripts["copy-binary-assets"], /fake-connector\.json/u);
	assert.ok(existsSync(fixturePath));
	assert.match(packageJson.scripts["copy-assets"], /fake-connector-process\.mjs/u);
	assert.match(packageJson.scripts["copy-binary-assets"], /fake-connector-process\.mjs/u);
	assert.ok(existsSync(processModulePath));
});

test("package-content validation catches missing public exports and assets", () => {
	const files = [
		"dist/cli.js",
		"dist/external-connector.js",
		"dist/external-connector.d.ts",
		"dist/index.js",
		"dist/index.d.ts",
		"dist/core/connector/packaged-driver.js",
		"dist/core/connector/packaged-driver.d.ts",
		"dist/core/connector/assets/fake-connector.json",
		"dist/core/connector/assets/fake-connector-process.mjs",
		"package.json",
		"npm-shrinkwrap.json",
	].map((path) => ({ path }));
	assert.equal(assertPackageContents({ files }).length, files.length);
	assert.throws(
		() => assertPackageContents({ files: files.filter(({ path }) => !path.endsWith("fake-connector.json")) }),
		/missing package\/dist\/core\/connector\/assets\/fake-connector\.json/u,
	);
	assert.throws(
		() => assertPackageContents({ files: files.filter(({ path }) => !path.endsWith("fake-connector-process.mjs")) }),
		/missing package\/dist\/core\/connector\/assets\/fake-connector-process\.mjs/u,
	);
});

test("outside-repository validation supports missing external paths and rejects filesystem roots", () => {
	const root = mkdtempSync(join(tmpdir(), "aos-pack-work-root-test-"));
	try {
		const workRoot = join(root, "missing", "work-root");
		assert.equal(assertOutsideRepository(workRoot, repoRoot), join(realpathSync(root), "missing", "work-root"));
		assert.throws(
			() => assertOutsideRepository(parse(root).root, repoRoot),
			/cannot be a filesystem root/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("outside-repository validation rejects a link or junction targeting the repository", (t) => {
	const root = mkdtempSync(join(tmpdir(), "aos-pack-work-root-link-test-"));
	try {
		const repositoryLink = join(root, "repository-link");
		try {
			symlinkSync(repoRoot, repositoryLink, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			const unsupportedCodes = new Set(["EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);
			if (typeof error === "object" && error !== null && "code" in error && unsupportedCodes.has(error.code)) {
				t.skip(`filesystem links are unavailable: ${error.code}`);
				return;
			}
			throw error;
		}
		assert.throws(
			() => assertOutsideRepository(repositoryLink, repoRoot),
			/must be outside the repository/u,
		);
		assert.throws(
			() => assertOutsideRepository(join(repositoryLink, "missing-work-root"), repoRoot),
			/must be outside the repository/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("external npm install boots the CLI and SDK before executing the public subpath runtimes", () => {
	const root = mkdtempSync(join(tmpdir(), "aos-pack-test-"));
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
		runInstalledBootSmokes({ installDirectory: install, env: process.env });
		const runner = join(install, "runner.mjs");
		writeFileSync(
			runner,
			[
				'import { runPackagedExternalAgentDriverFixture } from "aos-agent/external-connector";',
				'const resolved = import.meta.resolve("aos-agent/external-connector");',
				'const trace = await runPackagedExternalAgentDriverFixture();',
				'process.stdout.write(`${JSON.stringify({ resolved, trace })}\\n`);',
				"",
			].join("\n"),
		);
		for (const command of [process.execPath, "bun"]) {
			const output = JSON.parse(run(command, [runner], install));
			assert.match(output.resolved, /external-install[\\/]node_modules[\\/]aos-agent[\\/]dist[\\/]external-connector\.js$/u);
			assertExecutedTrace(output.trace);
		}

		const compiledDirectory = join(install, "compiled");
		mkdirSync(join(compiledDirectory, "external-connector-assets"), { recursive: true });
		const executable = join(compiledDirectory, process.platform === "win32" ? "packaged-smoke.exe" : "packaged-smoke");
		const compiledRunner = join(install, "compiled-runner.mjs");
		writeFileSync(
			compiledRunner,
			[
				'import { runPackagedExternalAgentDriverFixture } from "aos-agent/external-connector";',
				'const trace = await runPackagedExternalAgentDriverFixture();',
				'process.stdout.write(`${JSON.stringify({ trace })}\\n`);',
				"",
			].join("\n"),
		);
		run(
			"bun",
			["build", "--compile", "--no-compile-autoload-bunfig", compiledRunner, "--outfile", executable],
			install,
		);
		copyFileSync(
			join(install, "node_modules", "aos-agent", "dist", "core", "connector", "assets", "fake-connector.json"),
			join(compiledDirectory, "external-connector-assets", "fake-connector.json"),
		);
		copyFileSync(
			join(install, "node_modules", "aos-agent", "dist", "core", "connector", "assets", "fake-connector-process.mjs"),
			join(compiledDirectory, "external-connector-assets", "fake-connector-process.mjs"),
		);
		assertExecutedTrace(JSON.parse(run(executable, [], compiledDirectory)).trace);
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
