#!/usr/bin/env node

import process from "node:process";
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
	"timers",
	"processes",
	"files",
	"pendingWrites",
	"reservations",
	"statusLabels",
	"retries",
	"credentials",
	"listeners",
	"backlog",
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

class DeterministicSoakClock {
	#now = 0;
	#nextId = 1;
	#timers = new Map();
	#runawayLimit;

	constructor(runawayLimit = 10_000) {
		if (!Number.isSafeInteger(runawayLimit) || runawayLimit < 1) throw new RangeError("runawayLimit must be positive");
		this.#runawayLimit = runawayLimit;
	}

	setTimeout(callback, delayMs) {
		if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError("delayMs must be a non-negative integer");
		const id = this.#nextId++;
		this.#timers.set(id, { id, dueAt: this.#now + delayMs, callback });
		return id;
	}

	clearTimeout(id) {
		this.#timers.delete(id);
	}

	advanceBy(delayMs) {
		const target = this.#now + delayMs;
		let executions = 0;
		for (;;) {
			const timer = [...this.#timers.values()].sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
			if (timer === undefined || timer.dueAt > target) break;
			if (++executions > this.#runawayLimit) throw new Error("deterministic soak clock exceeded runaway limit");
			this.#now = timer.dueAt;
			this.#timers.delete(timer.id);
			timer.callback();
		}
		this.#now = target;
	}

	pendingCount() {
		return this.#timers.size;
	}

	monotonicNow() {
		return this.#now;
	}
}

class ResourceRegistry {
	#resources = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, new Set()]));
	#peaks = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, 0]));

	acquire(name, id) {
		const resources = this.#resources[name];
		if (resources === undefined) throw new Error(`Unknown soak resource: ${name}`);
		if (resources.has(id)) throw new Error(`Duplicate soak resource: ${name}:${id}`);
		resources.add(id);
		this.#peaks[name] = Math.max(this.#peaks[name], resources.size);
	}

	release(name, id) {
		this.#resources[name]?.delete(id);
	}

	snapshot(clock) {
		const snapshot = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, this.#resources[name].size]));
		snapshot.timers = clock.pendingCount();
		return Object.freeze(snapshot);
	}

	peaks() {
		return Object.freeze({ ...this.#peaks });
	}
}

function createFauxProvider(iterations) {
	let pendingResponses = iterations;
	let callCount = 0;
	return {
		consume(fault) {
			if (pendingResponses < 1) throw new Error("faux provider response queue exhausted");
			pendingResponses -= 1;
			callCount += 1;
			return fault === "provider_error" ? "retryable_error" : "ok";
		},
		state() {
			return Object.freeze({ kind: "faux", callCount, pendingResponses });
		},
	};
}

function createFakeConnector(clock, registry, provider) {
	return {
		run(iteration, fault) {
			const attemptId = `attempt-${iteration}`;
			const timerId = `${attemptId}:timer`;
			const resources = [
				["activeRuns", attemptId],
				["processes", `${attemptId}:process`],
				["files", `${attemptId}:state`],
				["pendingWrites", `${attemptId}:write`],
				["reservations", `${attemptId}:capacity`],
				["statusLabels", `${attemptId}:status`],
				["credentials", `${attemptId}:lease`],
				["listeners", `${attemptId}:listener`],
				["backlog", `${attemptId}:backlog`],
			];
			for (const [name, id] of resources) registry.acquire(name, id);
			const timer = clock.setTimeout(() => {}, 3);
			registry.acquire("timers", timerId);
			let retryId;

			try {
				const result = provider.consume(fault);
				if (fault === "cancel") clock.clearTimeout(timer);
				else clock.advanceBy(3);
				registry.release("timers", timerId);
				if (result === "retryable_error") {
					retryId = `${attemptId}:retry`;
					registry.acquire("retries", retryId);
					const retryTimerId = `${attemptId}:retry-timer`;
					const retryTimer = clock.setTimeout(() => {}, 5);
					registry.acquire("timers", retryTimerId);
					clock.advanceBy(5);
					registry.release("timers", retryTimerId);
					registry.release("retries", retryId);
				}
				if (fault === "file_publish") {
					registry.acquire("files", `${attemptId}:publish-temp`);
					registry.release("files", `${attemptId}:publish-temp`);
				}
				if (fault === "pending_write" || fault === "leak_pending_write") {
					registry.acquire("pendingWrites", `${attemptId}:overflow-write`);
					if (fault !== "leak_pending_write") registry.release("pendingWrites", `${attemptId}:overflow-write`);
				}
			} finally {
				clock.clearTimeout(timer);
				registry.release("timers", timerId);
				if (retryId !== undefined) registry.release("retries", retryId);
				for (const [name, id] of resources) registry.release(name, id);
			}
		},
	};
}

function assertZeroResources(snapshot, context) {
	const residual = Object.entries(snapshot).filter(([, count]) => count !== 0);
	if (residual.length > 0) {
		throw new Error(`${context} retained ${residual.map(([name, count]) => `${name}=${count}`).join(", ")}`);
	}
}

export function runLine13Soak(options) {
	const iterations = options.iterations ?? 224;
	const plateauWindow = options.plateauWindow ?? 32;
	const faultPlan = options.faultPlan ?? LINE13_SOAK_FAULT_PLAN;
	if (!Number.isSafeInteger(iterations) || iterations < 2) throw new RangeError("iterations must be at least 2");
	if (!Number.isSafeInteger(plateauWindow) || plateauWindow < 2 || plateauWindow > iterations) {
		throw new RangeError("plateauWindow must be between 2 and iterations");
	}
	if (!Array.isArray(faultPlan) || faultPlan.length < 1) throw new TypeError("faultPlan must be non-empty");

	const headSha = assertFullSha(options.headSha);
	const platform = assertChoice(options.platform, LINE13_PLATFORMS, "platform");
	const clock = new DeterministicSoakClock(options.runawayLimit);
	const registry = new ResourceRegistry();
	const provider = createFauxProvider(iterations);
	const connector = createFakeConnector(clock, registry, provider);
	const samples = [];
	const faultCounts = Object.fromEntries(faultPlan.map((fault) => [fault, 0]));

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const fault = faultPlan[iteration % faultPlan.length];
		faultCounts[fault] += 1;
		connector.run(iteration, fault);
		samples.push(registry.snapshot(clock));
	}

	const baseline = Object.freeze(Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, 0])));
	const plateau = samples.slice(-plateauWindow);
	for (const [index, sample] of plateau.entries()) assertZeroResources(sample, `plateau sample ${index}`);
	const final = registry.snapshot(clock);
	assertZeroResources(final, "soak cleanup");
	const providerState = provider.state();
	if (providerState.pendingResponses !== 0) throw new Error("faux provider retained queued responses");

	const evidence = Object.freeze({
		schemaVersion: 1,
		type: "soak",
		headSha,
		platform,
		state: "passed",
		evidenceClass: "structural_fake",
		iterations,
		plateauWindow,
		clock: Object.freeze({ monotonicTimeMs: clock.monotonicNow(), pendingTimers: clock.pendingCount() }),
		resources: Object.freeze({ baseline, peaks: registry.peaks(), final, plateauSamples: plateau.length }),
		faults: Object.freeze({ plan: Object.freeze([...faultPlan]), counts: Object.freeze(faultCounts) }),
		provider: providerState,
		safety: Object.freeze({ credentialsPersisted: false, rawPayloadPersisted: false, pathsPersisted: false }),
	});
	assertSanitized(evidence);
	return Object.freeze({ ...evidence, digest: digestJson(evidence) });
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-soak.mjs [options]

Runs the bounded deterministic fake-Connector/faux-provider soak. It never uses
vendor APIs, accounts, credentials, network access, or real-time sleeps.

Options:
  --head-sha <sha>       Full candidate commit SHA (required)
  --platform <name>      windows, linux, or macos (required)
  --iterations <count>   Deterministic iterations (default: 224)
  --plateau-window <n>   Final cleanup samples that must be zero (default: 32)
  --out <path>           Sanitized JSON evidence output (required)
  --help                 Show this help
`);
}

function main() {
	const args = parseFlagArguments(process.argv.slice(2), {
		"--head-sha": "value",
		"--platform": "value",
		"--iterations": "value",
		"--plateau-window": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
	for (const flag of ["--head-sha", "--platform", "--out"]) {
		if (args[flag] === undefined) throw new Error(`${flag} is required`);
	}
	const evidence = runLine13Soak({
		headSha: args["--head-sha"],
		platform: args["--platform"],
		...(args["--iterations"] === undefined ? {} : { iterations: Number(args["--iterations"]) }),
		...(args["--plateau-window"] === undefined ? {} : { plateauWindow: Number(args["--plateau-window"]) }),
	});
	writeJsonAtomic(args["--out"], evidence);
	console.log(`Line 13 deterministic soak passed: ${evidence.digest}`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
