#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import spawn from "cross-spawn";
import {
	LINE13_PLATFORMS,
	assertChoice,
	assertFullSha,
	assertSanitized,
	digestJson,
	isMain,
	parseFlagArguments,
	readJson,
	writeJsonAtomic,
} from "./line13-evidence-common.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const OWNERSHIP_MARKER = ".line13-upgrade-owned";

function parseVersion(version) {
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new TypeError(`Invalid version: ${version}`);
	const [core, prerelease] = version.split("-", 2);
	return { parts: core.split(".").map(Number), prerelease };
}

function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (let index = 0; index < 3; index += 1) {
		if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
	}
	if (a.prerelease === b.prerelease) return 0;
	if (a.prerelease === undefined) return 1;
	if (b.prerelease === undefined) return -1;
	return a.prerelease.localeCompare(b.prerelease);
}

export function selectPreviousPublishedVersion(currentVersion, versions) {
	parseVersion(currentVersion);
	if (!Array.isArray(versions)) throw new TypeError("Published versions must be an array");
	const candidates = versions
		.filter((version) => typeof version === "string" && VERSION_PATTERN.test(version) && !version.includes("-"))
		.filter((version) => compareVersions(version, currentVersion) < 0)
		.sort(compareVersions);
	const previousVersion = candidates.at(-1);
	if (previousVersion === undefined) throw new Error(`No previous stable aos-agent release exists before ${currentVersion}`);
	return previousVersion;
}

function runCommand(command, args, options = {}) {
	const result = spawn.sync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs ?? 600_000,
		maxBuffer: 4 * 1024 * 1024,
		killSignal: "SIGTERM",
		windowsHide: true,
	});
	if (result.status !== 0 && options.allowFailure !== true) {
		const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2_000);
		throw new Error(`${command} exited ${result.status ?? "without status"}${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	return result;
}

export function resolvePreviousPublishedVersion(currentVersion, command = runCommand) {
	const result = command("npm", ["view", "aos-agent", "versions", "--json"], {});
	const output = typeof result === "string" ? result : result.stdout;
	return selectPreviousPublishedVersion(currentVersion, JSON.parse(output));
}

export function previousSpecFromResolution(value) {
	if (
		value?.schemaVersion !== 1 ||
		value.type !== "previous_version" ||
		value.package !== "aos-agent" ||
		value.state !== "resolved"
	) throw new Error("Previous-version resolution has an invalid identity or state");
	parseVersion(value.currentVersion);
	parseVersion(value.previousVersion);
	if (compareVersions(value.previousVersion, value.currentVersion) >= 0) {
		throw new Error("Resolved previous version must be older than the candidate version");
	}
	return `aos-agent@${value.previousVersion}`;
}

function isWithinPath(child, parent) {
	const childRelative = relative(parent, child);
	return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function assertOutsideRepository(workRoot, repoRoot) {
	const resolvedWorkRoot = resolve(workRoot);
	if (isWithinPath(resolvedWorkRoot, realpathSync(repoRoot))) {
		throw new Error(`Upgrade work root must be outside the repository: ${resolvedWorkRoot}`);
	}
	return resolvedWorkRoot;
}

function minimalPackageEnvironment(workRoot) {
	const environment = {
		PATH: process.env.PATH ?? "",
		HOME: join(workRoot, "home"),
		USERPROFILE: join(workRoot, "home"),
		TMPDIR: join(workRoot, "tmp"),
		TMP: join(workRoot, "tmp"),
		TEMP: join(workRoot, "tmp"),
		NPM_CONFIG_USERCONFIG: join(workRoot, "npm-userconfig"),
		NPM_CONFIG_GLOBALCONFIG: join(workRoot, "npm-globalconfig"),
		NPM_CONFIG_CACHE: join(workRoot, "npm-cache"),
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		AOS_AGENT_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	return environment;
}

function hashFiles(paths) {
	const hash = createHash("sha256");
	for (const path of paths) hash.update(readFileSync(path));
	return `sha256:${hash.digest("hex")}`;
}

function installPackage(spec, installDirectory, environment) {
	mkdirSync(installDirectory, { recursive: true });
	writeFileSync(join(installDirectory, "package.json"), '{"private":true,"type":"module"}\n', {
		encoding: "utf8",
		mode: 0o600,
	});
	runCommand("npm", [
		"install",
		"--omit=dev",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		"--save-exact",
		spec,
	], { cwd: installDirectory, env: environment });
	const packageJsonPath = join(installDirectory, "node_modules", "aos-agent", "package.json");
	const entrypointPath = join(installDirectory, "node_modules", "aos-agent", "dist", "index.js");
	const connectorEntrypointPath = join(installDirectory, "node_modules", "aos-agent", "dist", "external-connector.js");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	return Object.freeze({
		name: "aos-agent",
		version: packageJson.version,
		digest: hashFiles([packageJsonPath, entrypointPath, ...(existsSync(connectorEntrypointPath) ? [connectorEntrypointPath] : [])]),
	});
}

export function createSystemPackageExecutor(workRoot) {
	const environment = minimalPackageEnvironment(workRoot);
	for (const directory of [environment.HOME, environment.TMP, environment.NPM_CONFIG_CACHE]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const path of [environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG]) {
		writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	}
	return {
		install({ spec, installDirectory }) {
			return installPackage(spec, installDirectory, environment);
		},
		generatePrevious({ installDirectory, stateDirectory }) {
			const runner = join(installDirectory, "generate-previous.mjs");
			writeFileSync(runner, [
				'import { mkdirSync, writeFileSync } from "node:fs";',
				'import { basename, join } from "node:path";',
				'import { ProjectTrustStore, SessionManager, SettingsManager } from "aos-agent";',
				'const state = process.argv[2];',
				'const version = process.argv[3];',
				'const cwd = join(state, "workspace"); const agentDir = join(state, "agent"); const sessions = join(state, "sessions");',
				'mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true }); mkdirSync(sessions, { recursive: true });',
				'const session = SessionManager.create(cwd, sessions, { id: "line13-upgrade" });',
				'session.appendCustomEntry("line13.previous", { sanitized: true }); session.flushPendingSession();',
				'const settings = SettingsManager.create(cwd, agentDir); settings.setDefaultProvider("faux"); settings.setSteeringMode("one-at-a-time"); await settings.flush();',
				'new ProjectTrustStore(agentDir).set(cwd, true);',
				'const publication = { schemaVersion: 1, packageVersion: version, sessionFile: `sessions/${basename(session.getSessionFile())}`, cwd: "workspace", agentDir: "agent", auth: "not_configured", identity: "anonymous", connector: "disabled" };',
				'writeFileSync(join(state, "publication.json"), `${JSON.stringify(publication, undefined, 2)}\\n`, { mode: 0o600 });',
			].join("\n"), { encoding: "utf8", mode: 0o600 });
			const packageJson = JSON.parse(readFileSync(join(installDirectory, "node_modules", "aos-agent", "package.json"), "utf8"));
			runCommand(process.execPath, [runner, stateDirectory, packageJson.version], {
				cwd: installDirectory,
				env: environment,
			});
			return readJson(join(stateDirectory, "publication.json"));
		},
		migrateCandidate({ installDirectory, stateDirectory, fault }) {
			const runner = join(installDirectory, `migrate-${fault}.mjs`);
			writeFileSync(runner, [
				'import { runPackagedLine13UpgradeMigration } from "aos-agent/external-connector";',
				'try { const result = await runPackagedLine13UpgradeMigration({ stateDirectory: process.argv[2], fault: process.argv[3] }); process.stdout.write(`${JSON.stringify({ ok: true, result })}\\n`); }',
				'catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\\n`); process.exitCode = 2; }',
			].join("\n"), { encoding: "utf8", mode: 0o600 });
			const result = runCommand(process.execPath, [runner, stateDirectory, fault], {
				cwd: installDirectory,
				env: environment,
				allowFailure: true,
			});
			const receipt = JSON.parse((result.stdout ?? "").trim());
			return Object.freeze({ status: result.status, ...receipt });
		},
	};
}

function readPublishedSchema(stateDirectory) {
	const state = readJson(join(stateDirectory, "publication.json"));
	if (state.schemaVersion !== 1 && state.schemaVersion !== 2) throw new Error("Interrupted migration exposed partial state");
	return state.schemaVersion;
}

function runScenario(executor, installs, root, fault) {
	mkdirSync(root, { recursive: true });
	executor.generatePrevious({ installDirectory: installs.previous, stateDirectory: root });
	const faultReceipt = executor.migrateCandidate({ installDirectory: installs.candidate, stateDirectory: root, fault });
	if (faultReceipt.status === 0 || faultReceipt.error !== `injected_${fault}`) {
		throw new Error(`Packaged candidate did not observe ${fault}`);
	}
	const recoveredSchemaVersion = readPublishedSchema(root);
	if (fault === "before_publish" && recoveredSchemaVersion !== 1) throw new Error("Pre-publish fault did not preserve old state");
	if (fault === "after_publish" && recoveredSchemaVersion !== 2) throw new Error("Post-publish fault did not preserve new state");
	const temporaryPath = join(root, "publication.json.next");
	if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
	const restarted = executor.migrateCandidate({ installDirectory: installs.candidate, stateDirectory: root, fault: "none" });
	const repeated = executor.migrateCandidate({ installDirectory: installs.candidate, stateDirectory: root, fault: "none" });
	if (restarted.status !== 0 || repeated.status !== 0) throw new Error("Packaged candidate restart migration failed");
	if (restarted.result?.stateDigest !== repeated.result?.stateDigest) throw new Error("Packaged migration is not idempotent");
	if (
		repeated.result?.entrypoint !== "aos-agent/external-connector" ||
		repeated.result?.adapter !== "packaged_durable_state_migration" ||
		repeated.result?.owners?.length !== 6
	) throw new Error("Packaged candidate migration adapter was not invoked");
	return Object.freeze({
		fault,
		recoveredSchemaVersion,
		finalSchemaVersion: readPublishedSchema(root),
		stateDigest: repeated.result.stateDigest,
	});
}

export function runLine13UpgradeHarness(options, executor) {
	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, LINE13_PLATFORMS, "platform");
	const repoRoot = options.repoRoot ?? resolve(import.meta.dirname, "../../..");
	const workRoot = assertOutsideRepository(options.workRoot, repoRoot);
	if (existsSync(workRoot)) throw new Error(`Upgrade work root already exists: ${workRoot}`);
	mkdirSync(workRoot, { recursive: true });
	writeFileSync(join(workRoot, OWNERSHIP_MARKER), "line13-upgrade\n", { encoding: "utf8", mode: 0o600 });
	let cleanup = false;
	try {
		const packageExecutor = executor ?? createSystemPackageExecutor(workRoot);
		const previousInstall = join(workRoot, "previous-install");
		const candidateInstall = join(workRoot, "candidate-install");
		const previousPackage = packageExecutor.install({ spec: options.previousSpec, installDirectory: previousInstall });
		const candidatePackage = packageExecutor.install({ spec: options.candidateSpec, installDirectory: candidateInstall });
		const installs = { previous: previousInstall, candidate: candidateInstall };
		const scenarios = ["before_publish", "after_publish"].map((fault) =>
			runScenario(packageExecutor, installs, join(workRoot, `state-${fault}`), fault),
		);
		const unsigned = {
			schemaVersion: 2,
			type: "upgrade",
			headSha,
			platform,
			state: "passed",
			evidenceClass: executor === undefined ? "packaged_execution" : "offline_fixture",
			entrypoints: Object.freeze({ previous: "aos-agent", candidate: "aos-agent/external-connector" }),
			previousPackage,
			candidatePackage,
			outsideRepository: true,
			scenarios: Object.freeze(scenarios),
			restartValidated: true,
			idempotentMigration: true,
			secretsPersisted: false,
			cleanup: true,
		};
		assertSanitized(unsigned);
		cleanup = true;
		return Object.freeze({ ...unsigned, digest: digestJson(unsigned) });
	} finally {
		if (existsSync(workRoot) && existsSync(join(workRoot, OWNERSHIP_MARKER))) {
			rmSync(workRoot, { recursive: true, force: true });
			cleanup = true;
		}
		if (!cleanup) throw new Error("Line 13 upgrade cleanup could not be confirmed");
	}
}

function required(args, flag) {
	if (args[flag] === undefined) throw new Error(`${flag} is required`);
	return args[flag];
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-upgrade.mjs <command> [options]

Commands:
  resolve-previous --current-version <version> --out <path>
  run --head-sha <sha> --platform <name> --previous-spec <spec> \\
      --candidate-spec <spec> --work-root <dir> --out <path>
`);
}

function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (command === undefined || command === "--help") return printUsage();
	const args = parseFlagArguments(rest, {
		"--current-version": "value",
		"--head-sha": "value",
		"--platform": "value",
		"--previous-spec": "value",
		"--previous-version-file": "value",
		"--candidate-spec": "value",
		"--work-root": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) return printUsage();
	if (command === "resolve-previous") {
		const currentVersion = required(args, "--current-version");
		const previousVersion = resolvePreviousPublishedVersion(currentVersion);
		writeJsonAtomic(required(args, "--out"), {
			schemaVersion: 1,
			type: "previous_version",
			package: "aos-agent",
			currentVersion,
			previousVersion,
			state: "resolved",
		});
		console.log(previousVersion);
		return;
	}
	if (command !== "run") throw new Error(`Unknown command: ${command}`);
	const previousSpec = args["--previous-spec"] ?? (
		args["--previous-version-file"] === undefined
			? undefined
			: previousSpecFromResolution(readJson(args["--previous-version-file"]))
	);
	if (previousSpec === undefined) throw new Error("run requires --previous-spec or --previous-version-file");
	const evidence = runLine13UpgradeHarness({
		headSha: required(args, "--head-sha"),
		platform: required(args, "--platform"),
		previousSpec,
		candidateSpec: required(args, "--candidate-spec"),
		workRoot: required(args, "--work-root"),
	});
	writeJsonAtomic(required(args, "--out"), evidence);
	console.log(`Line 13 packaged upgrade passed: ${evidence.digest}`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
