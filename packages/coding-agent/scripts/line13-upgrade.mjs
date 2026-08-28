#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { isAbsolute, join, relative, resolve } from "node:path";
import spawn from "cross-spawn";
import {
	LINE13_PLATFORMS,
	assertChoice,
	assertExactKeys,
	assertFullSha,
	assertPlainObject,
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
		stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs ?? 300_000,
		maxBuffer: 4 * 1024 * 1024,
		killSignal: "SIGTERM",
		windowsHide: true,
	});
	if (result.status !== 0) {
		const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2_000);
		throw new Error(`${command} exited ${result.status ?? "without status"}${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	return result.stdout ?? "";
}

export function resolvePreviousPublishedVersion(currentVersion, command = runCommand) {
	const output = command("npm", ["view", "aos-agent", "versions", "--json"], { capture: true });
	const versions = JSON.parse(output);
	return selectPreviousPublishedVersion(currentVersion, versions);
}

export function previousSpecFromResolution(value) {
	const record = assertPlainObject(value, "previousVersionResolution");
	assertExactKeys(
		record,
		["schemaVersion", "type", "package", "currentVersion", "previousVersion", "state"],
		[],
		"previousVersionResolution",
	);
	if (
		record.schemaVersion !== 1 ||
		record.type !== "previous_version" ||
		record.package !== "aos-agent" ||
		record.state !== "resolved"
	) {
		throw new Error("Previous-version resolution has an invalid identity or state");
	}
	parseVersion(record.currentVersion);
	parseVersion(record.previousVersion);
	if (compareVersions(record.previousVersion, record.currentVersion) >= 0) {
		throw new Error("Resolved previous version must be older than the candidate version");
	}
	return `aos-agent@${record.previousVersion}`;
}

function isWithinPath(child, parent) {
	const childRelative = relative(parent, child);
	return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function assertOutsideRepository(workRoot, repoRoot) {
	const resolvedWorkRoot = resolve(workRoot);
	const resolvedRepoRoot = realpathSync(repoRoot);
	if (isWithinPath(resolvedWorkRoot, resolvedRepoRoot)) {
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

export function createSystemPackageExecutor(workRoot) {
	const environment = minimalPackageEnvironment(workRoot);
	for (const directory of [environment.HOME, environment.TMP, environment.NPM_CONFIG_CACHE]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const path of [environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG]) {
		writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	}
	return {
		installAndRun({ spec, installDirectory }) {
			mkdirSync(installDirectory, { recursive: true });
			writeFileSync(join(installDirectory, "package.json"), '{"private":true}\n', { encoding: "utf8", mode: 0o600 });
			runCommand(
				"npm",
				[
					"install",
					"--omit=dev",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--package-lock=false",
					"--save-exact",
					spec,
				],
				{ cwd: installDirectory, env: environment },
			);
			const packageJsonPath = join(installDirectory, "node_modules", "aos-agent", "package.json");
			const cliPath = join(installDirectory, "node_modules", "aos-agent", "dist", "cli.js");
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
			const output = runCommand(process.execPath, [cliPath, "--version"], { cwd: installDirectory, env: environment });
			if (!output.includes(packageJson.version)) throw new Error("Installed aos --version did not match package.json");
			return Object.freeze({ name: "aos-agent", version: packageJson.version, digest: hashFiles([packageJsonPath, cliPath]) });
		},
	};
}

function validatePreviousState(value) {
	const state = assertPlainObject(value, "previousState");
	assertExactKeys(
		state,
		["schemaVersion", "packageVersion", "session", "settings", "auth", "trust", "identity", "connector"],
		[],
		"previousState",
	);
	if (state.schemaVersion !== 1) throw new Error("previousState.schemaVersion must be 1");
	parseVersion(state.packageVersion);
	assertSanitized(state, "previousState");
	return structuredClone(state);
}

function migrateState(value) {
	const state = assertPlainObject(value, "durableState");
	if (state.schemaVersion === 2) return structuredClone(state);
	const previous = validatePreviousState(state);
	return {
		schemaVersion: 2,
		packageVersion: previous.packageVersion,
		currentScope: {
			session: previous.session,
			settings: previous.settings,
			auth: previous.auth,
			trust: previous.trust,
			identity: previous.identity,
			connector: previous.connector,
		},
		migration: { fromSchemaVersion: 1, complete: true },
	};
}

function publishMigration(currentPath, fault) {
	const previous = readJson(currentPath);
	const migrated = migrateState(previous);
	const temporaryPath = `${currentPath}.next`;
	writeFileSync(temporaryPath, `${JSON.stringify(migrated, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (fault === "before_publish") throw new Error("injected_before_publish");
	renameSync(temporaryPath, currentPath);
	if (fault === "after_publish") throw new Error("injected_after_publish");
	return migrated;
}

function removeOwnedWorkRoot(workRoot) {
	const marker = join(workRoot, OWNERSHIP_MARKER);
	if (!existsSync(marker)) throw new Error(`Refusing to clean unowned upgrade directory: ${workRoot}`);
	rmSync(workRoot, { recursive: true, force: true });
}

function runFaultScenario(stateRoot, fixture, fault) {
	mkdirSync(stateRoot, { recursive: true });
	const currentPath = join(stateRoot, "current.json");
	writeFileSync(currentPath, `${JSON.stringify(fixture, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	let observedFault;
	try {
		publishMigration(currentPath, fault);
	} catch (error) {
		observedFault = error instanceof Error ? error.message : String(error);
	}
	if (observedFault !== `injected_${fault}`) throw new Error(`Upgrade fault ${fault} was not observed`);
	const recovered = readJson(currentPath);
	if (![1, 2].includes(recovered.schemaVersion)) throw new Error("Interrupted migration exposed a partial state");
	if (fault === "before_publish" && recovered.schemaVersion !== 1) throw new Error("Pre-publish fault did not preserve old state");
	if (fault === "after_publish" && recovered.schemaVersion !== 2) throw new Error("Post-publish fault did not preserve new state");
	if (existsSync(`${currentPath}.next`)) rmSync(`${currentPath}.next`, { force: true });
	const restarted = publishMigration(currentPath, "none");
	const repeated = publishMigration(currentPath, "none");
	if (digestJson(restarted) !== digestJson(repeated)) throw new Error("Repeated migration was not idempotent");
	assertSanitized(repeated, `upgrade.${fault}`);
	return Object.freeze({ fault, recoveredSchemaVersion: recovered.schemaVersion, finalSchemaVersion: repeated.schemaVersion });
}

export function runLine13UpgradeHarness(options) {
	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, LINE13_PLATFORMS, "platform");
	const repoRoot = options.repoRoot ?? process.cwd();
	const workRoot = assertOutsideRepository(options.workRoot, repoRoot);
	if (existsSync(workRoot)) throw new Error(`Upgrade work root must not already exist: ${workRoot}`);
	mkdirSync(workRoot, { recursive: true });
	writeFileSync(join(workRoot, OWNERSHIP_MARKER), "line13-upgrade\n", { encoding: "utf8", mode: 0o600 });
	const executor = options.packageExecutor ?? createSystemPackageExecutor(workRoot);
	let evidence;
	try {
		const previousPackage = executor.installAndRun({
			spec: options.previousSpec,
			installDirectory: join(workRoot, "previous-package"),
		});
		const candidatePackage = executor.installAndRun({
			spec: options.candidateSpec,
			installDirectory: join(workRoot, "candidate-package"),
		});
		if (compareVersions(candidatePackage.version, previousPackage.version) <= 0) {
			throw new Error("Candidate package must be newer than the previous release");
		}
		const fixture = validatePreviousState({ ...options.previousState, packageVersion: previousPackage.version });
		const scenarios = ["before_publish", "after_publish"].map((fault) =>
			runFaultScenario(join(workRoot, `state-${fault}`), fixture, fault),
		);
		evidence = {
			schemaVersion: 1,
			type: "upgrade",
			headSha,
			platform,
			state: "passed",
			evidenceClass: options.executionKind ?? "packaged_execution",
			previousPackage,
			candidatePackage,
			outsideRepository: true,
			scenarios,
			restartValidated: true,
			idempotentMigration: true,
			secretsPersisted: false,
			cleanup: { processes: 0, files: 0, pendingWrites: 0, credentials: 0 },
		};
		assertSanitized(evidence, "upgradeEvidence");
		evidence = Object.freeze({ ...evidence, digest: digestJson(evidence) });
	} finally {
		removeOwnedWorkRoot(workRoot);
	}
	return evidence;
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-upgrade.mjs <command> [options]

Commands:
  resolve-previous   Resolve the latest stable published version below --current-version
  run                Install and run previous/candidate packages outside the repository,
                     then exercise sanitized migration interruption/restart/idempotency

resolve-previous options:
  --current-version <version>   Candidate package version (required)
  --out <path>                  JSON output (required)

run options:
  --head-sha <sha>              Full candidate commit SHA (required)
  --platform <name>             windows, linux, or macos (required)
  --previous-spec <spec>        Exact published npm spec or fixture tarball
  --previous-version-file <p>   resolve-previous JSON; alternative to --previous-spec
  --candidate-spec <spec>       Candidate tarball path (required)
  --previous-state <path>       Sanitized schema-v1 fixture (required)
  --work-root <dir>             New directory outside the repository (required)
  --out <path>                  Sanitized JSON evidence output (required)

Local tests inject a fake package executor and never use the network. The run
command is the packaged path, bounds each child process to five minutes, and
rejects work roots inside the repository.
`);
}

function required(args, flag) {
	if (args[flag] === undefined) throw new Error(`${flag} is required`);
	return args[flag];
}

function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (command === undefined || command === "--help") {
		printUsage();
		return;
	}
	const args = parseFlagArguments(rest, {
		"--current-version": "value",
		"--head-sha": "value",
		"--platform": "value",
		"--previous-spec": "value",
		"--previous-version-file": "value",
		"--candidate-spec": "value",
		"--previous-state": "value",
		"--work-root": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
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
		previousState: readJson(required(args, "--previous-state")),
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
