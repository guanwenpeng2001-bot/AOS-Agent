#!/usr/bin/env node

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import {
	PLATFORMS,
	RUNTIME_KINDS,
	assertChoice,
	assertExactKeys,
	assertFullSha,
	assertPlainObject,
	assertSanitized,
	assertSha256,
	digestJson,
	isMain,
	parseFlagArguments,
	writeJsonAtomic,
} from "./pack-smoke-common.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "../../..");
const INTERNAL_PACKAGE_DIRECTORIES = Object.freeze([
	"telemetry",
	"ai",
	"agent",
	"protocol",
	"client",
	"tui",
]);
const REQUIRED_PACKAGE_FILES = Object.freeze([
	"package/dist/cli.js",
	"package/dist/external-connector.js",
	"package/dist/external-connector.d.ts",
	"package/dist/external-connector-testing.js",
	"package/dist/external-connector-testing.d.ts",
	"package/dist/index.js",
	"package/dist/index.d.ts",
	"package/dist/core/connector/packaged-driver.js",
	"package/dist/core/connector/packaged-driver.d.ts",
	"package/dist/core/connector/assets/fake-connector.json",
	"package/dist/core/connector/assets/fake-connector-process.mjs",
	"package/package.json",
]);
const RUNTIME_STATES = Object.freeze(["passed", "failed", "unavailable", "not_run"]);
const RESULT_STATES = Object.freeze(["passed", "failed", "not_run"]);
// PR-07 replaces this transitional fixture ID during naming convergence.
export const PACKAGED_FIXTURE_TOOL_CALL_ID = "aos.fake-tool-call";

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function platformName() {
	if (process.platform === "win32") return "windows";
	if (process.platform === "darwin") return "macos";
	return process.platform === "linux" ? "linux" : undefined;
}

function commandDiagnostic(result) {
	return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2_000);
}

function runCommand(command, args, options = {}) {
	const result = spawn.sync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env,
		stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs ?? 300_000,
		maxBuffer: 8 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) {
		const diagnostic = commandDiagnostic(result);
		throw new Error(`${command} exited ${result.status ?? "without status"}${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	return result.stdout ?? "";
}

function isWithinPath(child, parent) {
	const childRelative = relative(parent, child);
	return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function canonicalizePath(path) {
	let existingPath = resolve(path);
	const missingSegments = [];
	while (!existsSync(existingPath)) {
		const parent = dirname(existingPath);
		if (parent === existingPath) throw new Error(`Path has no existing parent: ${path}`);
		missingSegments.unshift(basename(existingPath));
		existingPath = parent;
	}
	return resolve(realpathSync(existingPath), ...missingSegments);
}

export function assertOutsideRepository(workRoot, repoRoot = defaultRepoRoot) {
	const resolvedWorkRoot = canonicalizePath(workRoot);
	const resolvedRepoRoot = realpathSync(repoRoot);
	if (isWithinPath(resolvedWorkRoot, resolvedRepoRoot)) {
		throw new Error(`Package-smoke work root must be outside the repository: ${resolvedWorkRoot}`);
	}
	if (resolvedWorkRoot === parse(resolvedWorkRoot).root) {
		throw new Error("Package-smoke work root cannot be a filesystem root");
	}
	return resolvedWorkRoot;
}

function createMinimalEnvironment(runDirectory, npmCache) {
	const home = join(runDirectory, "home");
	const temporary = join(runDirectory, "tmp");
	const userConfig = join(runDirectory, "npm-userconfig");
	const globalConfig = join(runDirectory, "npm-globalconfig");
	for (const directory of [home, temporary]) mkdirSync(directory, { recursive: true });
	for (const path of [userConfig, globalConfig]) writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	const environment = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		NPM_CONFIG_USERCONFIG: userConfig,
		NPM_CONFIG_GLOBALCONFIG: globalConfig,
		NPM_CONFIG_CACHE: npmCache,
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		AOS_AGENT_OFFLINE: "1",
		AOS_AGENT_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	return environment;
}

function parsePackResult(output, context) {
	let value;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`${context} npm-pack output was not JSON`);
	}
	const records = Array.isArray(value)
		? value
		: Object.values(assertPlainObject(value, `${context}PackResults`));
	if (records.length !== 1) throw new Error(`${context} npm-pack output was ambiguous`);
	const result = assertPlainObject(records[0], `${context}PackResult`);
	if (typeof result.filename !== "string" || !Array.isArray(result.files)) {
		throw new Error(`${context} npm-pack result was incomplete`);
	}
	return result;
}

export function assertPackageContents(packResult) {
	const record = assertPlainObject(packResult, "packResult");
	if (!Array.isArray(record.files)) throw new TypeError("packResult.files must be an array");
	const files = new Set(record.files.map((entry, index) => {
		const file = assertPlainObject(entry, `packResult.files[${index}]`);
		if (typeof file.path !== "string") throw new TypeError(`packResult.files[${index}].path must be a string`);
		return `package/${file.path.replaceAll("\\", "/")}`;
	}));
	for (const required of REQUIRED_PACKAGE_FILES) {
		if (!files.has(required)) throw new Error(`Candidate package is missing ${required}`);
	}
	return Object.freeze([...files].sort());
}

function packPackage(packageDirectory, packDirectory, environment) {
	const output = runCommand(
		npmCommand(),
		["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory, packageDirectory],
		{ cwd: packDirectory, env: environment },
	);
	const result = parsePackResult(output, packageDirectory);
	return { result, tarballPath: join(packDirectory, result.filename) };
}

function packageIdentity(packageDirectory) {
	const value = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	if (typeof value.name !== "string") throw new Error(`${packageDirectory} has no package name`);
	return value.name;
}

function localFileSpec(path) {
	return `file:${path.replaceAll("\\", "/")}`;
}

function createInstallManifest(repoRoot, packDirectory, candidateTarball, environment) {
	const dependencies = { "aos-agent": localFileSpec(candidateTarball) };
	const overrides = {};
	for (const directory of INTERNAL_PACKAGE_DIRECTORIES) {
		const packageDirectory = join(repoRoot, "packages", directory);
		const packed = packPackage(packageDirectory, packDirectory, environment);
		overrides[packageIdentity(packageDirectory)] = localFileSpec(packed.tarballPath);
	}
	// Workspace packages are unpublished. Install only the candidate so npm uses
	// its shrinkwrap for registry tarballs already in the local cache. Listing
	// those workspace packages as sibling dependencies would resolve their
	// package.json ranges from the registry and fail `--offline` with ENOTCACHED.
	return { private: true, type: "module", dependencies, overrides };
}

function assertTrace(value) {
	const trace = assertPlainObject(value, "trace");
	assertExactKeys(
		trace,
		[
			"schemaVersion",
			"fixtureId",
			"providerId",
			"fakeProviderId",
			"defaultEnabled",
			"credentialMode",
			"networkMode",
			"events",
			"receipts",
			"toolResult",
			"lifecycle",
		],
		[],
		"trace",
	);
	if (
		trace.schemaVersion !== 1 ||
		trace.fixtureId !== "aos.fake-connector" ||
		trace.providerId !== "aos.fake-connector" ||
		trace.fakeProviderId !== "aos.fake-provider" ||
		trace.defaultEnabled !== false ||
		trace.credentialMode !== "none" ||
		trace.networkMode !== "disabled" ||
		!Array.isArray(trace.events) ||
		trace.events.map((event) => event?.kind).join(",") !== "capabilities,start,tool,resume,cancel"
	) {
		throw new Error("Packaged fake Connector trace is invalid");
	}
	for (const [index, eventValue] of trace.events.entries()) {
		const event = assertPlainObject(eventValue, `trace.events[${index}]`);
		assertExactKeys(event, ["sequence", "kind", "input", "output"], [], `trace.events[${index}]`);
		if (
			event.sequence !== index + 1 ||
			typeof event.input !== "string" ||
			event.input.length === 0 ||
			typeof event.output !== "string" ||
			event.output.length === 0
		) throw new Error(`Packaged fake Connector event ${index + 1} is invalid`);
	}
	if (!Array.isArray(trace.receipts) || trace.receipts.length !== 3) {
		throw new Error("Packaged fake Connector receipt trace is incomplete");
	}
	const expectedReceipts = [
		["run", "suspended"],
		["resume", "succeeded"],
		["cancel", "cancelled"],
	];
	for (const [index, receiptValue] of trace.receipts.entries()) {
		const receipt = assertPlainObject(receiptValue, `trace.receipts[${index}]`);
		assertExactKeys(
			receipt,
			["phase", "attemptReceiptId", "attemptId", "providerId", "status", "sideEffectState"],
			[],
			`trace.receipts[${index}]`,
		);
		if (
			receipt.phase !== expectedReceipts[index][0] ||
			receipt.status !== expectedReceipts[index][1] ||
			receipt.providerId !== "aos.fake-connector" ||
			receipt.sideEffectState !== "none" ||
			typeof receipt.attemptReceiptId !== "string" ||
			receipt.attemptReceiptId.length === 0 ||
			typeof receipt.attemptId !== "string" ||
			receipt.attemptId.length === 0
		) throw new Error(`Packaged fake Connector receipt ${index + 1} is invalid`);
	}
	const toolResult = assertPlainObject(trace.toolResult, "trace.toolResult");
	assertExactKeys(
		toolResult,
		["toolCallId", "toolName", "ok", "sideEffectState", "output"],
		[],
		"trace.toolResult",
	);
	if (
		toolResult.toolCallId !== PACKAGED_FIXTURE_TOOL_CALL_ID ||
		toolResult.toolName !== "fixture.echo" ||
		toolResult.ok !== true ||
		toolResult.sideEffectState !== "none" ||
		toolResult.output !== "echo:deterministic"
	) throw new Error("Packaged fake Connector tool result is invalid");
	const lifecycle = assertPlainObject(trace.lifecycle, "trace.lifecycle");
	const expectedLifecycle = {
		capabilities: 1,
		probeCapabilities: 1,
		createAttempt: 2,
		runAttempt: 1,
		tool: 1,
		resumeAttempt: 1,
		cancelAttempt: 1,
		reconcileAttempt: 1,
		dispose: 1,
	};
	assertExactKeys(lifecycle, Object.keys(expectedLifecycle), [], "trace.lifecycle");
	if (Object.entries(expectedLifecycle).some(([key, count]) => lifecycle[key] !== count)) {
		throw new Error("Packaged fake Connector lifecycle counters are invalid");
	}
	return trace;
}

function parseProbeOutput(output, packageDirectory, requireResolvedPath) {
	let value;
	try {
		value = JSON.parse(output.trim());
	} catch {
		throw new Error("Packaged runtime output was not JSON");
	}
	const probe = assertPlainObject(value, "runtimeProbe");
	const trace = assertTrace(probe.trace);
	if (requireResolvedPath) {
		if (typeof probe.resolved !== "string") throw new Error("Packaged runtime did not report its resolved export");
		const resolvedEntry = realpathSync(fileURLToPath(probe.resolved));
		const installedPackage = realpathSync(packageDirectory);
		const installedEntry = realpathSync(join(installedPackage, "dist", "external-connector-testing.js"));
		const resolvedIdentity = statSync(resolvedEntry, { bigint: true });
		const installedIdentity = statSync(installedEntry, { bigint: true });
		const resolvesInstalledEntry =
			resolvedIdentity.dev === installedIdentity.dev && resolvedIdentity.ino === installedIdentity.ino;
		if (!resolvesInstalledEntry && !isWithinPath(resolvedEntry, installedPackage)) {
			throw new Error("Packaged runtime resolved repository-owned files outside its install");
		}
		if (!resolvesInstalledEntry) {
			throw new Error("Packaged runtime resolved an unexpected public export entry");
		}
	}
	return trace;
}

function runtimeResult(runtime, headSha, state, value) {
	return Object.freeze({ runtime, headSha, state, digest: digestJson(value) });
}

function runProbe(runtime, command, args, options) {
	try {
		const output = runCommand(command, args, { cwd: options.cwd, env: options.env });
		const trace = parseProbeOutput(output, options.packageDirectory, options.requireResolvedPath);
		return runtimeResult(runtime, options.headSha, "passed", { runtime, trace });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`Package-smoke ${runtime} probe failed: ${reason}`);
		return runtimeResult(runtime, options.headSha, "failed", { runtime, state: "failed", reason });
	}
}

export function bunIsAvailable(environment, cwd) {
	const result = spawn.sync("bun", ["--version"], {
		cwd,
		encoding: "utf8",
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		windowsHide: true,
	});
	return result.status === 0;
}

function writeRuntimeProbes(installDirectory) {
	const source = [
		'import * as externalConnector from "aos-agent/external-connector";',
		'import { runPackagedExternalAgentDriverFixture } from "aos-agent/external-connector/testing";',
		'if ("runPackagedExternalAgentDriverFixture" in externalConnector || "PackagedExternalAgentDriverTrace" in externalConnector) throw new Error("Main External Connector subpath exposes test support");',
		'const trace = await runPackagedExternalAgentDriverFixture();',
		'const resolved = import.meta.resolve("aos-agent/external-connector/testing");',
		'process.stdout.write(`${JSON.stringify({ resolved, trace })}\\n`);',
		"",
	].join("\n");
	const compiledSource = [
		'import { runPackagedExternalAgentDriverFixture } from "aos-agent/external-connector/testing";',
		'const trace = await runPackagedExternalAgentDriverFixture();',
		'process.stdout.write(`${JSON.stringify({ trace })}\\n`);',
		"",
	].join("\n");
	const probePath = join(installDirectory, "runtime-probe.mjs");
	const compiledProbePath = join(installDirectory, "compiled-runtime-probe.mjs");
	writeFileSync(probePath, source, { encoding: "utf8", mode: 0o600 });
	writeFileSync(compiledProbePath, compiledSource, { encoding: "utf8", mode: 0o600 });
	return { probePath, compiledProbePath };
}

export function runInstalledBootSmokes(options) {
	const executable = join(
		options.installDirectory,
		"node_modules",
		".bin",
		process.platform === "win32" ? "aos.cmd" : "aos",
	);
	for (const args of [["--version"], ["--help"], ["--list-models"]]) {
		runCommand(executable, args, {
			cwd: options.installDirectory,
			env: options.env,
			timeoutMs: 120_000,
		});
	}

	const sdkProbePath = join(options.installDirectory, "sdk-boot-probe.mjs");
	writeFileSync(
		sdkProbePath,
		[
			'import { createAgentSession } from "aos-agent";',
			'const { session } = await createAgentSession({ session: { mode: "memory" } });',
			'if (typeof session?.dispose !== "function") throw new Error("SDK session creation returned no disposable session");',
			"session.dispose();",
			'process.stdout.write("sdk-session-created\\n");',
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);
	const sdkOutput = runCommand(process.execPath, [sdkProbePath], {
		cwd: options.installDirectory,
		env: options.env,
		timeoutMs: 120_000,
	});
	if (sdkOutput.trim() !== "sdk-session-created") {
		throw new Error("Installed SDK session-create smoke returned unexpected output");
	}
}

function runInstalledRuntimes(options) {
	const packageDirectory = join(options.installDirectory, "node_modules", "aos-agent");
	const probes = writeRuntimeProbes(options.installDirectory);
	const nodeResult = runProbe("node", process.execPath, [probes.probePath], {
		...options,
		cwd: options.installDirectory,
		packageDirectory,
		requireResolvedPath: true,
	});
	if (!bunIsAvailable(options.env, options.installDirectory)) {
		return Object.freeze([
			nodeResult,
			runtimeResult("bun", options.headSha, "unavailable", { runtime: "bun", state: "unavailable" }),
			runtimeResult("compiled", options.headSha, "unavailable", { runtime: "compiled", state: "unavailable" }),
		]);
	}
	const bunResult = runProbe("bun", "bun", [probes.probePath], {
		...options,
		cwd: options.installDirectory,
		packageDirectory,
		requireResolvedPath: true,
	});
	const compiledDirectory = join(options.installDirectory, "compiled");
	mkdirSync(join(compiledDirectory, "external-connector-assets"), { recursive: true });
	const executablePath = join(
		compiledDirectory,
		process.platform === "win32" ? "packaged-smoke.exe" : "packaged-smoke",
	);
	let compiledResult;
	try {
		runCommand(
			"bun",
			[
				"build",
				"--compile",
				"--no-compile-autoload-bunfig",
				probes.compiledProbePath,
				"--outfile",
				executablePath,
			],
			{ cwd: options.installDirectory, env: options.env },
		);
		copyFileSync(
			join(packageDirectory, "dist", "core", "connector", "assets", "fake-connector.json"),
			join(compiledDirectory, "external-connector-assets", "fake-connector.json"),
		);
		copyFileSync(
			join(packageDirectory, "dist", "core", "connector", "assets", "fake-connector-process.mjs"),
			join(compiledDirectory, "external-connector-assets", "fake-connector-process.mjs"),
		);
		compiledResult = runProbe("compiled", executablePath, [], {
			...options,
			cwd: compiledDirectory,
			packageDirectory,
			requireResolvedPath: false,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		compiledResult = runtimeResult("compiled", options.headSha, "failed", {
			runtime: "compiled",
			state: "failed",
			reason,
		});
	}
	return Object.freeze([nodeResult, bunResult, compiledResult]);
}

export function createPackageSmokeResult({ headSha, platform, state, runtimes }) {
	const result = {
		schemaVersion: 1,
		type: "package_smoke",
		headSha: assertFullSha(headSha),
		platform: assertChoice(platform, PLATFORMS, "platform"),
		state,
		evidenceClass: "packaged_execution",
		outsideRepository: true,
		runtimes,
	};
	assertPackageSmokeResult({ ...result, digest: digestJson(result) });
	return Object.freeze({ ...result, digest: digestJson(result) });
}

export function assertPackageSmokeResult(value, options = {}) {
	const result = assertPlainObject(value, "packageSmoke");
	assertExactKeys(
		result,
		["schemaVersion", "type", "headSha", "platform", "state", "evidenceClass", "outsideRepository", "runtimes", "digest"],
		[],
		"packageSmoke",
	);
	if (
		result.schemaVersion !== 1 ||
		result.type !== "package_smoke" ||
		result.evidenceClass !== "packaged_execution" ||
		result.outsideRepository !== true ||
		!RESULT_STATES.includes(result.state)
	) throw new Error("Package-smoke identity or state is invalid");
	assertFullSha(result.headSha);
	assertChoice(result.platform, PLATFORMS, "packageSmoke.platform");
	assertSha256(result.digest, "packageSmoke.digest");
	if (!Array.isArray(result.runtimes) || result.runtimes.length !== RUNTIME_KINDS.length) {
		throw new Error("Package-smoke runtime matrix is incomplete");
	}
	for (const [index, runtimeKind] of RUNTIME_KINDS.entries()) {
		const runtime = assertPlainObject(result.runtimes[index], `packageSmoke.runtimes[${index}]`);
		assertExactKeys(runtime, ["runtime", "headSha", "state", "digest"], [], `packageSmoke.runtimes[${index}]`);
		if (
			runtime.runtime !== runtimeKind ||
			runtime.headSha !== result.headSha ||
			!RUNTIME_STATES.includes(runtime.state)
		) throw new Error(`Package-smoke runtime ${runtimeKind} is invalid`);
		assertSha256(runtime.digest, `packageSmoke.runtimes[${index}].digest`);
		if (options.requirePassed === true && runtime.state !== "passed") {
			throw new Error(`Package-smoke runtime ${runtimeKind} did not pass`);
		}
	}
	const allPassed = result.runtimes.every((runtime) => runtime.state === "passed");
	if ((result.state === "passed") !== allPassed) {
		throw new Error("Package-smoke aggregate state does not match its runtime states");
	}
	const { digest, ...unsignedResult } = result;
	if (digestJson(unsignedResult) !== digest) throw new Error("Package-smoke digest does not match its contents");
	if (options.requirePassed === true && result.state !== "passed") throw new Error("Package smoke did not pass");
	assertSanitized(result, "packageSmoke");
	return result;
}

function validateDryRunInputs(repoRoot) {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "packages", "coding-agent", "package.json"), "utf8"));
	if (
		packageJson.bin?.aos !== "dist/cli.js" ||
		packageJson.exports?.["."]?.import !== "./dist/index.js"
	) {
		throw new Error("Package metadata does not expose the CLI and SDK boot entrypoints");
	}
	if (packageJson.exports?.["./external-connector"]?.import !== "./dist/external-connector.js") {
		throw new Error("Package metadata does not expose the External Connector subpath");
	}
	if (packageJson.exports?.["./external-connector/testing"]?.import !== "./dist/external-connector-testing.js") {
		throw new Error("Package metadata does not expose the External Connector test-support subpath");
	}
	for (const scriptName of ["copy-assets", "copy-binary-assets"]) {
		if (!packageJson.scripts?.[scriptName]?.includes("fake-connector")) {
			throw new Error(`${scriptName} does not package the fake Connector fixture`);
		}
	}
	const fixture = JSON.parse(readFileSync(
		join(repoRoot, "packages", "coding-agent", "src", "core", "connector", "assets", "fake-connector.json"),
		"utf8",
	));
	if (
		fixture.schemaVersion !== 1 ||
		fixture.fixtureId !== "aos.fake-connector" ||
		fixture.providerId !== "aos.fake-connector" ||
		fixture.fakeProviderId !== "aos.fake-provider" ||
		fixture.defaultEnabled !== false ||
		fixture.credentialMode !== "none" ||
		fixture.networkMode !== "disabled" ||
		!Array.isArray(fixture.operations) ||
		fixture.operations.map((operation) => operation?.kind).join(",") !== "start,tool,resume,cancel"
	) throw new Error("Packaged fake Connector fixture metadata is invalid");
}

export function runPackageSmoke(options) {
	const repoRoot = options.repoRoot ?? defaultRepoRoot;
	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, PLATFORMS, "platform");
	const actualPlatform = platformName();
	if (actualPlatform !== platform) throw new Error(`Requested ${platform} smoke on ${actualPlatform ?? process.platform}`);
	const workRoot = assertOutsideRepository(options.workRoot, repoRoot);
	if (options.dryRun === true) {
		validateDryRunInputs(repoRoot);
		return createPackageSmokeResult({
			headSha,
			platform,
			state: "not_run",
			runtimes: RUNTIME_KINDS.map((runtime) =>
				runtimeResult(runtime, headSha, "not_run", { runtime, state: "not_run" }),
			),
		});
	}
	mkdirSync(workRoot, { recursive: true });
	const runDirectory = mkdtempSync(join(workRoot, "run-"));
	let runtimes = RUNTIME_KINDS.map((runtime) =>
		runtimeResult(runtime, headSha, "not_run", { runtime, state: "not_run" }),
	);
	try {
		const npmCache = runCommand(npmCommand(), ["config", "get", "cache"], { cwd: repoRoot }).trim();
		const environment = createMinimalEnvironment(runDirectory, npmCache);
		runCommand(npmCommand(), ["run", "build:offline"], {
			cwd: repoRoot,
			env: environment,
			capture: false,
			timeoutMs: 900_000,
		});
		const packDirectory = join(runDirectory, "packs");
		mkdirSync(packDirectory, { recursive: true });
		const candidate = packPackage(join(repoRoot, "packages", "coding-agent"), packDirectory, environment);
		assertPackageContents(candidate.result);
		mkdirSync(dirname(options.candidateTarballOut), { recursive: true });
		copyFileSync(candidate.tarballPath, options.candidateTarballOut);
		const installDirectory = join(runDirectory, "external-install");
		mkdirSync(installDirectory, { recursive: true });
		const manifest = createInstallManifest(repoRoot, packDirectory, candidate.tarballPath, environment);
		writeFileSync(join(installDirectory, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		runCommand(
			npmCommand(),
			[
				"install",
				"--offline",
				"--ignore-scripts",
				"--omit=dev",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
			],
			{ cwd: installDirectory, env: environment, timeoutMs: 600_000 },
		);
		runInstalledBootSmokes({ installDirectory, env: environment });
		runtimes = runInstalledRuntimes({ headSha, installDirectory, env: environment });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`Package-smoke execution failed: ${reason}`);
		runtimes = runtimes.map((runtime) => runtime.state === "not_run"
			? runtimeResult(runtime.runtime, headSha, "failed", { runtime: runtime.runtime, state: "failed", reason })
			: runtime);
	} finally {
		rmSync(runDirectory, { recursive: true, force: true });
	}
	const state = runtimes.every((runtime) => runtime.state === "passed") ? "passed" : "failed";
	return createPackageSmokeResult({ headSha, platform, state, runtimes });
}

function required(args, flag) {
	if (args[flag] === undefined) throw new Error(`${flag} is required`);
	return args[flag];
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/pack-smoke.mjs [options]

Options:
  --head-sha <sha>              Full candidate commit SHA
  --platform <name>             windows, linux, or macos
  --work-root <dir>             Temporary parent outside the repository
  --candidate-tarball-out <p>   Persistent candidate tarball output
  --out <path>                  Sanitized package-smoke evidence output
  --dry-run                     Validate metadata/schema without building or executing
`);
}

function main() {
	const args = parseFlagArguments(process.argv.slice(2), {
		"--head-sha": "value",
		"--platform": "value",
		"--work-root": "value",
		"--candidate-tarball-out": "value",
		"--out": "value",
		"--dry-run": "boolean",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
	const dryRun = args["--dry-run"] === true;
	const workRoot = args["--work-root"] ?? (dryRun
		? join(tmpdir(), "aos-pack-smoke")
		: required(args, "--work-root"));
	const outputPath = args["--out"] ?? (dryRun ? undefined : required(args, "--out"));
	const result = runPackageSmoke({
		headSha: args["--head-sha"] ?? (dryRun
			? runCommand("git", ["rev-parse", "HEAD"], { cwd: defaultRepoRoot }).trim()
			: required(args, "--head-sha")),
		platform: args["--platform"] ?? (dryRun
			? platformName()
			: required(args, "--platform")),
		workRoot,
		candidateTarballOut: resolve(args["--candidate-tarball-out"] ?? (dryRun
			? join(workRoot, "aos-agent.tgz")
			: required(args, "--candidate-tarball-out"))),
		dryRun,
	});
	if (outputPath !== undefined) writeJsonAtomic(resolve(outputPath), result);
	if (result.state === "passed") {
		assertPackageSmokeResult(result, { requirePassed: true });
		console.log(`Packaged runtime smoke passed: ${result.digest}`);
		return;
	}
	if (result.state === "not_run") {
		console.log(`Packaged runtime smoke dry-run validated: ${result.digest}`);
		return;
	}
	const runtimeSummary = result.runtimes.map((runtime) => `${runtime.runtime}=${runtime.state}`).join(", ");
	throw new Error(`Packaged runtime smoke failed: ${result.digest} (${runtimeSummary})`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
