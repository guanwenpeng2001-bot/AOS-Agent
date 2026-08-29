#!/usr/bin/env node

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { isAbsolute, join, relative, resolve } from "node:path";
import spawn from "cross-spawn";
import {
	LINE13_PLATFORMS,
	assertChoice,
	assertFullSha,
	assertSanitized,
	digestJson,
	isMain,
	parseFlagArguments,
	writeJsonAtomic,
} from "./line13-evidence-common.mjs";

export const LINE13_SOAK_RESOURCE_NAMES = Object.freeze([
	"activeRuns",
	"backlog",
	"status",
	"credentials",
	"reservations",
	"processes",
	"timers",
	"files",
	"pendingWrites",
]);

export const LINE13_SOAK_OPERATION_PLAN = Object.freeze([
	"run",
	"switch",
	"fork",
	"import",
	"reload",
	"cancel",
	"restart",
]);

export const LINE13_SOAK_FAULT_PLAN = Object.freeze([
	"none",
	"provider_error",
	"cancel",
	"process_exit",
	"file_publish",
	"credential_reject",
	"pending_write",
]);

const OWNERSHIP_MARKER = ".line13-soak-owned";

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
	if (result.status !== 0) {
		const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2_000);
		throw new Error(`${command} exited ${result.status ?? "without status"}${diagnostic ? `: ${diagnostic}` : ""}`);
	}
	return result.stdout ?? "";
}

function isWithinPath(child, parent) {
	const childRelative = relative(parent, child);
	return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function assertOutsideRepository(workRoot, repoRoot) {
	const resolvedWorkRoot = resolve(workRoot);
	const resolvedRepoRoot = realpathSync(repoRoot);
	if (isWithinPath(resolvedWorkRoot, resolvedRepoRoot)) {
		throw new Error(`Soak work root must be outside the repository: ${resolvedWorkRoot}`);
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

function createSystemProductTraceExecutor(workRoot) {
	const environment = minimalPackageEnvironment(workRoot);
	for (const directory of [environment.HOME, environment.TMP, environment.NPM_CONFIG_CACHE]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const path of [environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG]) {
		writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	}
	return {
		run({ candidateSpec, installDirectory, iterations }) {
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
				candidateSpec,
			], { cwd: installDirectory, env: environment });
			const runnerPath = join(installDirectory, "line13-product-trace.mjs");
			writeFileSync(runnerPath, [
				'import { fileURLToPath } from "node:url";',
				'import { runPackagedLine13ProductTrace } from "aos-agent/external-connector";',
				'const result = await runPackagedLine13ProductTrace({ workDirectory: fileURLToPath(new URL("./state", import.meta.url)), iterations: Number(process.argv[2]) });',
				'process.stdout.write(`${JSON.stringify(result)}\\n`);',
			].join("\n"), { encoding: "utf8", mode: 0o600 });
			const output = runCommand(process.execPath, [runnerPath, String(iterations)], {
				cwd: installDirectory,
				env: environment,
			});
			return JSON.parse(output.trim());
		},
	};
}

function assertCanonicalClosure(snapshot, context) {
	for (const name of LINE13_SOAK_RESOURCE_NAMES) {
		const value = snapshot?.[name];
		if (!Number.isSafeInteger(value) || value < 0 || (name === "files" ? value > 1 : name === "status" ? value !== 1 : value !== 0)) {
			throw new Error(`${context} retained ${name}`);
		}
	}
}

function assertCanonicalTrace(trace, iterations, plateauWindow) {
	if (
		trace?.schemaVersion !== 1 ||
		trace.entrypoint !== "aos-agent/external-connector" ||
		trace.adapter !== "standard_product_composition" ||
		trace.iterations !== iterations
	) throw new Error("Packaged product trace has an invalid identity");
	if (!Array.isArray(trace.canonicalOwners) || new Set(trace.canonicalOwners).size !== 7) {
		throw new Error("Packaged product trace did not identify every canonical owner");
	}
	if (!Array.isArray(trace.samples) || trace.samples.length !== iterations) {
		throw new Error("Packaged product trace did not return every bounded sample");
	}
	if (!Array.isArray(trace.canonicalRecords) || trace.canonicalRecords.length !== iterations) {
		throw new Error("Packaged product trace did not return every canonical result sample");
	}
	for (const operation of LINE13_SOAK_OPERATION_PLAN) {
		if (!Number.isSafeInteger(trace.operations?.[operation]) || trace.operations[operation] < 1) {
			throw new Error(`Packaged product trace did not invoke ${operation}`);
		}
	}
	for (const [index, sample] of trace.samples.slice(-plateauWindow).entries()) {
		assertCanonicalClosure(sample, `Packaged product trace plateau sample ${index}`);
	}
	for (const [index, records] of trace.canonicalRecords.entries()) {
		if (
			records?.operation !== LINE13_SOAK_OPERATION_PLAN[index % LINE13_SOAK_OPERATION_PLAN.length] ||
			records.attempts !== 1 ||
			records.attemptReceipts !== 1 ||
			records.taskResults !== 1 ||
			records.runReceipts !== 1 ||
			records.providerId !== "aos.line13.external-connector" ||
			records.runId !== "line13-product-trace-run" ||
			![records.attemptId, records.attemptReceiptId, records.taskResultId, records.runReceiptId].every((id) => typeof id === "string" && id.length > 0)
		) throw new Error(`Packaged product trace canonical result sample ${index} is invalid`);
	}
	assertCanonicalClosure(trace.final, "Packaged product trace final sample");
	if (
		trace.connector?.providerId !== "aos.line13.external-connector" ||
		trace.connector.currentRegistrySize !== 1 ||
		trace.connector.attemptExecutions !== 1 + trace.operations.fork
	) throw new Error("Packaged product trace did not execute the registry-backed Connector");
	if (trace.provider?.kind !== "faux" || trace.provider.pendingResponses !== 0) {
		throw new Error("Packaged product trace retained faux responses");
	}
}

class DeterministicStructuralClock {
	#now = 0;
	#nextId = 1;
	#timers = new Map();

	set(callback, delayMs) {
		const id = this.#nextId++;
		this.#timers.set(id, { callback, dueAt: this.#now + delayMs });
		return id;
	}

	clear(id) {
		this.#timers.delete(id);
	}

	advance(delayMs) {
		const target = this.#now + delayMs;
		for (;;) {
			const next = [...this.#timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
			if (next === undefined || next[1].dueAt > target) break;
			this.#now = next[1].dueAt;
			this.#timers.delete(next[0]);
			next[1].callback();
		}
		this.#now = target;
	}

	snapshot() {
		return Object.freeze({ monotonicTimeMs: this.#now, pendingTimers: this.#timers.size });
	}
}

function runStructuralIteration(clock, resources, fault) {
	const acquired = ["activeRuns", "backlog", "status", "credentials", "reservations", "processes", "files", "pendingWrites"];
	for (const name of acquired) resources[name] += 1;
	const timer = clock.set(() => undefined, 3);
	resources.timers += 1;
	try {
		if (fault === "cancel") clock.clear(timer);
		else clock.advance(3);
		if (fault === "provider_error") {
			const retry = clock.set(() => undefined, 5);
			resources.timers += 1;
			clock.advance(5);
			clock.clear(retry);
			resources.timers -= 1;
		}
		if (fault === "pending_write") {
			resources.pendingWrites += 1;
			resources.pendingWrites -= 1;
		}
	} finally {
		clock.clear(timer);
		resources.timers -= 1;
		for (const name of acquired) resources[name] -= 1;
	}
}

/** Structural fault/accounting fixture. It is intentionally ineligible for final evidence. */
export function runLine13StructuralSoak(options) {
	const iterations = options.iterations ?? 224;
	const plateauWindow = options.plateauWindow ?? 32;
	if (!Number.isSafeInteger(iterations) || iterations < 2) throw new RangeError("iterations must be at least 2");
	if (!Number.isSafeInteger(plateauWindow) || plateauWindow < 2 || plateauWindow > iterations) {
		throw new RangeError("plateauWindow must be between 2 and iterations");
	}
	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, LINE13_PLATFORMS, "platform");
	const clock = new DeterministicStructuralClock();
	const resources = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, 0]));
	const faultCounts = Object.fromEntries(LINE13_SOAK_FAULT_PLAN.map((fault) => [fault, 0]));
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const fault = LINE13_SOAK_FAULT_PLAN[iteration % LINE13_SOAK_FAULT_PLAN.length];
		faultCounts[fault] += 1;
		runStructuralIteration(clock, resources, fault);
	}
	if (Object.values(resources).some((count) => count !== 0) || clock.snapshot().pendingTimers !== 0) {
		throw new Error("Structural soak retained a locally-accounted resource");
	}
	const final = Object.freeze({ ...resources });
	const unsigned = {
		schemaVersion: 2,
		type: "soak",
		headSha,
		platform,
		state: "passed",
		evidenceClass: "structural_fixture",
		iterations,
		plateauWindow,
		operations: Object.freeze(Object.fromEntries(LINE13_SOAK_OPERATION_PLAN.map((operation) => [operation, 0]))),
		canonicalOwners: Object.freeze([]),
		resources: Object.freeze({ final, plateauSamples: plateauWindow }),
		clock: clock.snapshot(),
		faults: Object.freeze({ plan: LINE13_SOAK_FAULT_PLAN, counts: Object.freeze(faultCounts) }),
		provider: Object.freeze({ kind: "faux", callCount: iterations, pendingResponses: 0 }),
		safety: Object.freeze({ credentialsPersisted: false, rawPayloadPersisted: false, pathsPersisted: false }),
	};
	return Object.freeze({ ...unsigned, digest: digestJson(unsigned) });
}

export async function runLine13Soak(options, executor) {
	const iterations = options.iterations ?? 28;
	const plateauWindow = options.plateauWindow ?? 14;
	if (!Number.isSafeInteger(iterations) || iterations < LINE13_SOAK_OPERATION_PLAN.length) {
		throw new RangeError(`iterations must be at least ${LINE13_SOAK_OPERATION_PLAN.length}`);
	}
	if (!Number.isSafeInteger(plateauWindow) || plateauWindow < 2 || plateauWindow > iterations) {
		throw new RangeError("plateauWindow must be between 2 and iterations");
	}
	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, LINE13_PLATFORMS, "platform");
	const repoRoot = options.repoRoot ?? resolve(import.meta.dirname, "../../..");
	const workRoot = assertOutsideRepository(options.workRoot, repoRoot);
	if (existsSync(workRoot)) throw new Error(`Soak work root already exists: ${workRoot}`);
	mkdirSync(workRoot, { recursive: true });
	writeFileSync(join(workRoot, OWNERSHIP_MARKER), "line13-soak\n", { encoding: "utf8", mode: 0o600 });
	let cleanup = false;
	try {
		const productExecutor = executor ?? createSystemProductTraceExecutor(workRoot);
		const trace = productExecutor.run({
			candidateSpec: options.candidateSpec,
			installDirectory: join(workRoot, "install"),
			iterations,
		});
		assertCanonicalTrace(trace, iterations, plateauWindow);
		const plateau = trace.samples.slice(-plateauWindow);
		const unsigned = {
			schemaVersion: 2,
			type: "soak",
			headSha,
			platform,
			state: "passed",
			evidenceClass: executor === undefined ? "product_trace" : "structural_fixture",
			iterations,
			plateauWindow,
			operations: trace.operations,
			canonicalOwners: trace.canonicalOwners,
			resources: Object.freeze({
				final: trace.final,
				plateauSamples: plateau.length,
				plateauDigest: digestJson(plateau),
			}),
			connector: trace.connector,
			provider: trace.provider,
			safety: Object.freeze({ credentialsPersisted: false, rawPayloadPersisted: false, pathsPersisted: false }),
		};
		assertSanitized(unsigned);
		cleanup = true;
		return Object.freeze({ ...unsigned, digest: digestJson(unsigned) });
	} finally {
		if (existsSync(workRoot) && existsSync(join(workRoot, OWNERSHIP_MARKER))) {
			rmSync(workRoot, { recursive: true, force: true });
			cleanup = true;
		}
		if (!cleanup) throw new Error("Line 13 soak cleanup could not be confirmed");
	}
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-soak.mjs [options]

Runs the packaged standard product composition with a faux provider. It never
uses vendor APIs, accounts, credentials, or network-enabled Connectors.

Options:
  --head-sha <sha>       Full candidate commit SHA (required)
  --platform <name>      windows, linux, or macos (required)
  --candidate-spec <p>   Candidate package tarball (required)
  --work-root <dir>      New directory outside the repository (required)
  --iterations <count>   Product operations (default: 28)
  --plateau-window <n>   Final closure samples (default: 14)
  --out <path>           Sanitized JSON evidence output (required)
`);
}

async function main() {
	const args = parseFlagArguments(process.argv.slice(2), {
		"--head-sha": "value",
		"--platform": "value",
		"--candidate-spec": "value",
		"--work-root": "value",
		"--iterations": "value",
		"--plateau-window": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) return printUsage();
	for (const flag of ["--head-sha", "--platform", "--candidate-spec", "--work-root", "--out"]) {
		if (args[flag] === undefined) throw new Error(`${flag} is required`);
	}
	const evidence = await runLine13Soak({
		headSha: args["--head-sha"],
		platform: args["--platform"],
		candidateSpec: args["--candidate-spec"],
		workRoot: args["--work-root"],
		...(args["--iterations"] === undefined ? {} : { iterations: Number(args["--iterations"]) }),
		...(args["--plateau-window"] === undefined ? {} : { plateauWindow: Number(args["--plateau-window"]) }),
	});
	writeJsonAtomic(args["--out"], evidence);
	console.log(`Line 13 packaged product soak passed: ${evidence.digest}`);
}

if (isMain(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
