#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import {
	LINE13_CONNECTORS,
	LINE13_PLATFORMS,
	LINE13_REQUIRED_CHECKS,
	LINE13_RUNTIME_KINDS,
	assertChoice,
	assertExactKeys,
	assertFullSha,
	assertPlainObject,
	assertSanitized,
	assertSha256,
	digestJson,
	isMain,
	parseFlagArguments,
	readJson,
	writeJsonAtomic,
} from "../packages/coding-agent/scripts/line13-evidence-common.mjs";
import { validateCertificationRecord } from "../packages/coding-agent/scripts/line13-certification.mjs";
import { LINE13_SOAK_RESOURCE_NAMES } from "../packages/coding-agent/scripts/line13-soak.mjs";

const PASS_STATE = "passed";
const FORBIDDEN_FINAL_STATES = new Set(["cancelled", "partial"]);

function rejectCancelledOrPartial(value, context) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => rejectCancelledOrPartial(item, `${context}[${index}]`));
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (typeof value.state === "string" && FORBIDDEN_FINAL_STATES.has(value.state)) {
		throw new Error(`${context}.state cannot be ${value.state}`);
	}
	for (const [key, item] of Object.entries(value)) rejectCancelledOrPartial(item, `${context}.${key}`);
}

function validateCheckRecord(value, expectedHead, context) {
	const record = assertPlainObject(value, context);
	assertExactKeys(record, ["id", "headSha", "state"], [], context);
	if (typeof record.id !== "string" || !LINE13_REQUIRED_CHECKS.includes(record.id)) {
		throw new Error(`${context}.id is not a required T9/T10 check`);
	}
	if (assertFullSha(record.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (record.state !== PASS_STATE) throw new Error(`${context} did not pass`);
	return Object.freeze({ ...record });
}

function validateNativeJob(value, expectedHead, platform, context) {
	const job = assertPlainObject(value, context);
	assertExactKeys(
		job,
		["schemaVersion", "type", "headSha", "platform", "state", "checkedOutStart", "checkedOutBeforeUpload", "checks"],
		[],
		context,
	);
	if (job.schemaVersion !== 1 || job.type !== "native_job") throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(job.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (job.platform !== platform) throw new Error(`${context}.platform is mixed`);
	if (job.state !== PASS_STATE) throw new Error(`${context} did not pass`);
	for (const key of ["checkedOutStart", "checkedOutBeforeUpload"]) {
		if (assertFullSha(job[key], `${context}.${key}`) !== expectedHead) throw new Error(`${context}.${key} is stale`);
	}
	if (!Array.isArray(job.checks)) throw new TypeError(`${context}.checks must be an array`);
	const checks = job.checks.map((check, index) => validateCheckRecord(check, expectedHead, `${context}.checks[${index}]`));
	const ids = new Set(checks.map((check) => check.id));
	for (const id of LINE13_REQUIRED_CHECKS) {
		if (!ids.has(id)) throw new Error(`${context} is missing required check ${id}`);
	}
	if (ids.size !== checks.length) throw new Error(`${context} contains duplicate checks`);
	return Object.freeze({ ...job, checks: Object.freeze(checks) });
}

function validatePackageSmoke(value, expectedHead, platform, context) {
	const smoke = assertPlainObject(value, context);
	assertExactKeys(
		smoke,
		[
			"schemaVersion",
			"type",
			"headSha",
			"platform",
			"state",
			"evidenceClass",
			"outsideRepository",
			"runtimes",
			"digest",
		],
		[],
		context,
	);
	if (smoke.schemaVersion !== 1 || smoke.type !== "package_smoke") throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(smoke.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (smoke.platform !== platform || smoke.state !== PASS_STATE) throw new Error(`${context} did not pass for ${platform}`);
	if (smoke.evidenceClass !== "packaged_execution" || smoke.outsideRepository !== true) {
		throw new Error(`${context} must execute packaged artifacts outside the repository`);
	}
	if (!Array.isArray(smoke.runtimes)) throw new TypeError(`${context}.runtimes must be an array`);
	const runtimes = new Set();
	for (const [index, value_] of smoke.runtimes.entries()) {
		const runtime = assertPlainObject(value_, `${context}.runtimes[${index}]`);
		assertExactKeys(runtime, ["runtime", "headSha", "state", "digest"], [], `${context}.runtimes[${index}]`);
		assertChoice(runtime.runtime, LINE13_RUNTIME_KINDS, `${context}.runtimes[${index}].runtime`);
		if (runtimes.has(runtime.runtime)) throw new Error(`${context} contains duplicate ${runtime.runtime} smoke`);
		runtimes.add(runtime.runtime);
		if (assertFullSha(runtime.headSha, `${context}.runtimes[${index}].headSha`) !== expectedHead) {
			throw new Error(`${context}.runtimes[${index}] is stale`);
		}
		if (runtime.state !== PASS_STATE) throw new Error(`${context}.${runtime.runtime} did not pass`);
		assertSha256(runtime.digest, `${context}.runtimes[${index}].digest`);
	}
	for (const runtime of LINE13_RUNTIME_KINDS) {
		if (!runtimes.has(runtime)) throw new Error(`${context} is missing ${runtime} packaged smoke`);
	}
	assertSha256(smoke.digest, `${context}.digest`);
	const unsigned = { ...smoke };
	delete unsigned.digest;
	if (smoke.digest !== digestJson(unsigned)) throw new Error(`${context}.digest does not match packaged evidence`);
	return smoke;
}

function validateSoak(value, expectedHead, platform, context) {
	const soak = assertPlainObject(value, context);
	assertExactKeys(
		soak,
		[
			"schemaVersion",
			"type",
			"headSha",
			"platform",
			"state",
			"evidenceClass",
			"iterations",
			"plateauWindow",
			"clock",
			"resources",
			"faults",
			"provider",
			"safety",
			"digest",
		],
		[],
		context,
	);
	if (soak.type !== "soak" || soak.schemaVersion !== 1) throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(soak.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (soak.platform !== platform || soak.state !== PASS_STATE || soak.evidenceClass !== "structural_fake") {
		throw new Error(`${context} did not pass deterministic fake soak for ${platform}`);
	}
	if (!Number.isSafeInteger(soak.iterations) || soak.iterations < 2) throw new Error(`${context}.iterations is invalid`);
	if (!Number.isSafeInteger(soak.plateauWindow) || soak.plateauWindow < 2 || soak.plateauWindow > soak.iterations) {
		throw new Error(`${context}.plateauWindow is invalid`);
	}
	const clock = assertPlainObject(soak.clock, `${context}.clock`);
	assertExactKeys(clock, ["monotonicTimeMs", "pendingTimers"], [], `${context}.clock`);
	if (!Number.isSafeInteger(clock.monotonicTimeMs) || clock.monotonicTimeMs < 0 || clock.pendingTimers !== 0) {
		throw new Error(`${context} retained or reported an invalid deterministic timer`);
	}
	const resources = assertPlainObject(soak.resources, `${context}.resources`);
	assertExactKeys(resources, ["baseline", "peaks", "final", "plateauSamples"], [], `${context}.resources`);
	const baseline = assertPlainObject(resources.baseline, `${context}.resources.baseline`);
	const peaks = assertPlainObject(resources.peaks, `${context}.resources.peaks`);
	const finalResources = assertPlainObject(resources.final, `${context}.resources.final`);
	assertExactKeys(finalResources, LINE13_SOAK_RESOURCE_NAMES, [], `${context}.resources.final`);
	assertExactKeys(baseline, LINE13_SOAK_RESOURCE_NAMES, [], `${context}.resources.baseline`);
	assertExactKeys(peaks, LINE13_SOAK_RESOURCE_NAMES, [], `${context}.resources.peaks`);
	for (const name of LINE13_SOAK_RESOURCE_NAMES) {
		if (baseline[name] !== 0 || finalResources[name] !== 0) throw new Error(`${context} retained ${name}=${finalResources[name]}`);
		if (!Number.isSafeInteger(peaks[name]) || peaks[name] < 0) throw new Error(`${context}.resources.peaks.${name} is invalid`);
	}
	if (resources.plateauSamples !== soak.plateauWindow) {
		throw new Error(`${context} does not contain a bounded plateau window`);
	}
	const provider = assertPlainObject(soak.provider, `${context}.provider`);
	assertExactKeys(provider, ["kind", "callCount", "pendingResponses"], [], `${context}.provider`);
	if (provider.kind !== "faux" || provider.callCount !== soak.iterations || provider.pendingResponses !== 0) {
		throw new Error(`${context} retained timers or faux responses`);
	}
	const faults = assertPlainObject(soak.faults, `${context}.faults`);
	assertExactKeys(faults, ["plan", "counts"], [], `${context}.faults`);
	if (!Array.isArray(faults.plan) || faults.plan.length < 1 || new Set(faults.plan).size !== faults.plan.length) {
		throw new Error(`${context}.faults.plan is invalid`);
	}
	const faultCounts = assertPlainObject(faults.counts, `${context}.faults.counts`);
	assertExactKeys(faultCounts, [...new Set(faults.plan)], [], `${context}.faults.counts`);
	if (Object.values(faultCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
		throw new Error(`${context}.faults.counts is invalid`);
	}
	if (Object.values(faultCounts).reduce((total, count) => total + count, 0) !== soak.iterations) {
		throw new Error(`${context}.faults.counts does not cover all iterations`);
	}
	const safety = assertPlainObject(soak.safety, `${context}.safety`);
	assertExactKeys(safety, ["credentialsPersisted", "rawPayloadPersisted", "pathsPersisted"], [], `${context}.safety`);
	if (Object.values(safety).some((persisted) => persisted !== false)) throw new Error(`${context} persisted sensitive evidence`);
	assertSha256(soak.digest, `${context}.digest`);
	const unsigned = { ...soak };
	delete unsigned.digest;
	if (soak.digest !== digestJson(unsigned)) throw new Error(`${context}.digest does not match soak evidence`);
	return soak;
}

function validateUpgrade(value, expectedHead, platform, context) {
	const upgrade = assertPlainObject(value, context);
	assertExactKeys(
		upgrade,
		[
			"schemaVersion",
			"type",
			"headSha",
			"platform",
			"state",
			"evidenceClass",
			"previousPackage",
			"candidatePackage",
			"outsideRepository",
			"scenarios",
			"restartValidated",
			"idempotentMigration",
			"secretsPersisted",
			"cleanup",
			"digest",
		],
		[],
		context,
	);
	if (upgrade.type !== "upgrade" || upgrade.schemaVersion !== 1) throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(upgrade.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (
		upgrade.platform !== platform ||
		upgrade.state !== PASS_STATE ||
		upgrade.evidenceClass !== "packaged_execution" ||
		upgrade.outsideRepository !== true
	) {
		throw new Error(`${context} is not packaged previous-release evidence for ${platform}`);
	}
	if (upgrade.restartValidated !== true || upgrade.idempotentMigration !== true || upgrade.secretsPersisted !== false) {
		throw new Error(`${context} did not prove sanitized restart and idempotent migration`);
	}
	for (const name of ["previousPackage", "candidatePackage"]) {
		const packageRecord = assertPlainObject(upgrade[name], `${context}.${name}`);
		assertExactKeys(packageRecord, ["name", "version", "digest"], [], `${context}.${name}`);
		if (packageRecord.name !== "aos-agent" || typeof packageRecord.version !== "string") {
			throw new Error(`${context}.${name} has an invalid package identity`);
		}
		assertSha256(packageRecord.digest, `${context}.${name}.digest`);
	}
	if (!Array.isArray(upgrade.scenarios) || upgrade.scenarios.length !== 2) {
		throw new Error(`${context}.scenarios must contain exactly both interruption points`);
	}
	const scenarios = new Set();
	for (const [index, value_] of upgrade.scenarios.entries()) {
		const scenario = assertPlainObject(value_, `${context}.scenarios[${index}]`);
		assertExactKeys(scenario, ["fault", "recoveredSchemaVersion", "finalSchemaVersion"], [], `${context}.scenarios[${index}]`);
		if (!["before_publish", "after_publish"].includes(scenario.fault) || scenarios.has(scenario.fault)) {
			throw new Error(`${context}.scenarios has an invalid or duplicate fault`);
		}
		scenarios.add(scenario.fault);
		const expectedRecovered = scenario.fault === "before_publish" ? 1 : 2;
		if (scenario.recoveredSchemaVersion !== expectedRecovered || scenario.finalSchemaVersion !== 2) {
			throw new Error(`${context}.${scenario.fault} did not recover an atomic migration`);
		}
	}
	for (const fault of ["before_publish", "after_publish"]) {
		if (!scenarios.has(fault)) throw new Error(`${context} is missing ${fault}`);
	}
	const cleanup = assertPlainObject(upgrade.cleanup, `${context}.cleanup`);
	assertExactKeys(cleanup, ["processes", "files", "pendingWrites", "credentials"], [], `${context}.cleanup`);
	for (const [name, count] of Object.entries(cleanup)) {
		if (count !== 0) throw new Error(`${context} retained ${name}=${count}`);
	}
	assertSha256(upgrade.digest, `${context}.digest`);
	const unsigned = { ...upgrade };
	delete unsigned.digest;
	if (upgrade.digest !== digestJson(unsigned)) throw new Error(`${context}.digest does not match upgrade evidence`);
	return upgrade;
}

function validateKnownGaps(value, expectedHead, context) {
	const record = assertPlainObject(value, context);
	assertExactKeys(record, ["schemaVersion", "type", "headSha", "state", "count", "totalAcceptanceCriteria"], [], context);
	if (record.schemaVersion !== 1 || record.type !== "known_gaps") throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(record.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (record.state !== PASS_STATE || record.count !== 0 || record.totalAcceptanceCriteria !== 24) {
		throw new Error(`${context} must report zero final known gaps across AC-01 through AC-24`);
	}
	return record;
}

function assertUniqueBy(values, selector, context) {
	const seen = new Set();
	for (const value of values) {
		const key = selector(value);
		if (seen.has(key)) throw new Error(`${context} contains duplicate ${key}`);
		seen.add(key);
	}
}

export function validateLine13EvidenceManifest(value, expectedHead) {
	const manifest = assertPlainObject(value, "manifest");
	assertExactKeys(
		manifest,
		[
			"schemaVersion",
			"type",
			"headSha",
			"requestedHeadSha",
			"state",
			"knownGaps",
			"platforms",
			"certifications",
			"createdBy",
		],
		["digest"],
		"manifest",
	);
	if (manifest.schemaVersion !== 1 || manifest.type !== "line13_final_evidence") {
		throw new Error("manifest has the wrong schema");
	}
	const headSha = assertFullSha(manifest.headSha, "manifest.headSha");
	const requestedHeadSha = assertFullSha(manifest.requestedHeadSha, "manifest.requestedHeadSha");
	if (headSha !== requestedHeadSha || headSha !== assertFullSha(expectedHead, "expectedHead")) {
		throw new Error("manifest is stale or mixes requested and checked-out heads");
	}
	if (manifest.state !== PASS_STATE || manifest.createdBy !== "repository_verifier") {
		throw new Error("manifest is not a completed repository-verifier record");
	}
	rejectCancelledOrPartial(manifest, "manifest");
	validateKnownGaps(manifest.knownGaps, headSha, "manifest.knownGaps");
	if (!Array.isArray(manifest.platforms)) throw new TypeError("manifest.platforms must be an array");
	if (manifest.platforms.length !== LINE13_PLATFORMS.length) {
		throw new Error("manifest.platforms must contain exactly the three native platforms");
	}
	assertUniqueBy(manifest.platforms, (platform) => platform.platform, "manifest.platforms");
	for (const platform of LINE13_PLATFORMS) {
		const record = manifest.platforms.find((candidate) => candidate.platform === platform);
		if (record === undefined) throw new Error(`manifest is missing native ${platform} evidence`);
		const context = `manifest.platforms.${platform}`;
		assertExactKeys(
			assertPlainObject(record, context),
			["platform", "headSha", "job", "packageSmoke", "soak", "upgrade", "structuralCertifications"],
			[],
			context,
		);
		if (record.headSha !== headSha) throw new Error(`${context} is stale`);
		validateNativeJob(record.job, headSha, platform, `${context}.job`);
		validatePackageSmoke(record.packageSmoke, headSha, platform, `${context}.packageSmoke`);
		validateSoak(record.soak, headSha, platform, `${context}.soak`);
		validateUpgrade(record.upgrade, headSha, platform, `${context}.upgrade`);
		if (!Array.isArray(record.structuralCertifications)) {
			throw new TypeError(`${context}.structuralCertifications must be an array`);
		}
		if (record.structuralCertifications.length !== LINE13_CONNECTORS.length) {
			throw new Error(`${context} must contain exactly one fake certification per connector`);
		}
		assertUniqueBy(record.structuralCertifications, (certification) => certification.connector, `${context}.structuralCertifications`);
		for (const connector of LINE13_CONNECTORS) {
			const certification = record.structuralCertifications.find((candidate) => candidate.connector === connector);
			if (certification === undefined) throw new Error(`${context} is missing ${connector} structural certification`);
			const validated = validateCertificationRecord(certification, `${context}.structuralCertifications.${connector}`);
			if (
				validated.headSha !== headSha ||
				validated.platform !== platform ||
				validated.evidenceClass !== "structural_fake" ||
				validated.state !== PASS_STATE
			) {
				throw new Error(`${context}.${connector} is not passing fake structural evidence`);
			}
		}
	}
	if (!Array.isArray(manifest.certifications)) throw new TypeError("manifest.certifications must be an array");
	if (manifest.certifications.length !== LINE13_CONNECTORS.length) {
		throw new Error("manifest.certifications must contain exactly one real state per connector");
	}
	assertUniqueBy(manifest.certifications, (certification) => certification.connector, "manifest.certifications");
	for (const connector of LINE13_CONNECTORS) {
		const claim = manifest.certifications.find((candidate) => candidate.connector === connector);
		if (claim === undefined) throw new Error(`manifest is missing ${connector} real certification state`);
		const claimRecord = assertPlainObject(claim, `manifest.certifications.${connector}`);
		assertExactKeys(claimRecord, ["connector", "productReady", "record"], [], `manifest.certifications.${connector}`);
		if (typeof claim.productReady !== "boolean") throw new TypeError(`${connector}.productReady must be a boolean`);
		const record = validateCertificationRecord(claim.record, `manifest.certifications.${connector}.record`);
		if (record.connector !== connector || record.headSha !== headSha || record.evidenceClass !== "product_certification") {
			throw new Error(`${connector} real certification is stale, mixed, or fake`);
		}
		if (claim.productReady ? record.state !== PASS_STATE : record.state === PASS_STATE) {
			throw new Error(`${connector} product-ready claim does not match its real certification state`);
		}
	}
	assertSanitized(manifest, "manifest");
	const unsigned = { ...manifest };
	delete unsigned.digest;
	if (manifest.digest !== undefined && manifest.digest !== digestJson(unsigned)) {
		throw new Error("manifest.digest does not match the exact evidence set");
	}
	return Object.freeze({ ...unsigned, digest: digestJson(unsigned) });
}

function exactlyOne(records, type, platform) {
	const matches = records.filter((record) => record?.type === type && (platform === undefined || record.platform === platform));
	if (matches.length !== 1) throw new Error(`Expected exactly one ${type}${platform ? ` for ${platform}` : ""}, found ${matches.length}`);
	return matches[0];
}

export function assembleLine13EvidenceManifest(records, expectedHead) {
	const headSha = assertFullSha(expectedHead, "expectedHead");
	const certifications = records.filter((record) => record?.type === "connector_certification");
	const realCertifications = certifications.filter((record) => record.evidenceClass === "product_certification");
	const structuralCertifications = certifications.filter((record) => record.evidenceClass === "structural_fake");
	const platforms = LINE13_PLATFORMS.map((platform) => ({
		platform,
		headSha,
		job: exactlyOne(records, "native_job", platform),
		packageSmoke: exactlyOne(records, "package_smoke", platform),
		soak: exactlyOne(records, "soak", platform),
		upgrade: exactlyOne(records, "upgrade", platform),
		structuralCertifications: structuralCertifications.filter((record) => record.platform === platform),
	}));
	const manifest = {
		schemaVersion: 1,
		type: "line13_final_evidence",
		headSha,
		requestedHeadSha: headSha,
		state: "passed",
		knownGaps: exactlyOne(records, "known_gaps"),
		platforms,
		certifications: LINE13_CONNECTORS.map((connector) => {
			const record = exactlyOne(
				realCertifications.filter((candidate) => candidate.connector === connector),
				"connector_certification",
			);
			return { connector, productReady: record.state === PASS_STATE, record };
		}),
		createdBy: "repository_verifier",
	};
	return validateLine13EvidenceManifest(manifest, headSha);
}

function collectJsonRecords(directory) {
	const records = [];
	const visit = (path) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const entryPath = join(path, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && entry.name.endsWith(".json")) {
				const value = readJson(entryPath);
				records.push(...(Array.isArray(value) ? value : [value]));
			}
		}
	};
	if (!statSync(directory).isDirectory()) throw new Error(`--records-dir is not a directory: ${directory}`);
	visit(directory);
	return records;
}

export function createNativeJobRecord({ headSha, platform, checkedOutStart, checkedOutBeforeUpload, state, checks }) {
	const record = {
		schemaVersion: 1,
		type: "native_job",
		headSha,
		platform,
		state,
		checkedOutStart,
		checkedOutBeforeUpload,
		checks: checks.map((id) => ({ id, headSha, state })),
	};
	validateNativeJob(record, headSha, platform, "nativeJob");
	return Object.freeze(record);
}

function printUsage() {
	console.log(`Usage: node scripts/verify-line13-evidence.mjs [mode] [options]

Modes:
  --manifest <path>       Verify one exact-head final manifest
  --records-dir <dir>     Assemble and verify records, then require --out
  --record-job            Emit one native job/check record, then require --out

Common:
  --expected-head <sha>   Full requested candidate SHA (required)
  --out <path>            Output for assembly or record generation

--record-job:
  --platform <name>       windows, linux, or macos
  --checked-out-start <sha>
  --checked-out-final <sha>
  --state passed
  --check <id>            Repeat for every required T9/T10 check

The verifier rejects stale or mixed heads, cancelled/partial records, nonzero
known gaps, missing native OS/runtime evidence, offline upgrade fixtures, and
fake records used as real product certification.
`);
}

function required(args, flag) {
	if (args[flag] === undefined) throw new Error(`${flag} is required`);
	return args[flag];
}

function main() {
	const args = parseFlagArguments(process.argv.slice(2), {
		"--manifest": "value",
		"--records-dir": "value",
		"--record-job": "boolean",
		"--expected-head": "value",
		"--platform": "value",
		"--checked-out-start": "value",
		"--checked-out-final": "value",
		"--state": "value",
		"--check": "repeatable",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
	const expectedHead = required(args, "--expected-head");
	if (args["--record-job"] === true) {
		const record = createNativeJobRecord({
			headSha: expectedHead,
			platform: required(args, "--platform"),
			checkedOutStart: required(args, "--checked-out-start"),
			checkedOutBeforeUpload: required(args, "--checked-out-final"),
			state: required(args, "--state"),
			checks: args["--check"] ?? [],
		});
		writeJsonAtomic(required(args, "--out"), record);
		return;
	}
	if (args["--manifest"] !== undefined) {
		const manifest = validateLine13EvidenceManifest(readJson(args["--manifest"]), expectedHead);
		console.log(`Line 13 exact-head evidence verified: ${manifest.digest}`);
		return;
	}
	if (args["--records-dir"] !== undefined) {
		const manifest = assembleLine13EvidenceManifest(collectJsonRecords(args["--records-dir"]), expectedHead);
		writeJsonAtomic(required(args, "--out"), manifest);
		console.log(`Line 13 exact-head evidence assembled and verified: ${manifest.digest}`);
		return;
	}
	throw new Error("Select --manifest, --records-dir, or --record-job; use --help for arguments");
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
