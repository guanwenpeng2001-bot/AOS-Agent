#!/usr/bin/env node

import process from "node:process";
import {
	LINE13_CONNECTORS,
	LINE13_PLATFORMS,
	assertChoice,
	assertExactKeys,
	assertFullSha,
	assertPlainObject,
	assertSafeReasonCode,
	assertSanitized,
	assertSha256,
	digestJson,
	isMain,
	parseFlagArguments,
	readJson,
	writeJsonAtomic,
} from "./line13-evidence-common.mjs";

const CHECK_NAMES = Object.freeze(["handshake", "start", "cancel", "resume", "tool"]);
const RECORD_STATES = Object.freeze(["passed", "failed", "not_run", "unavailable"]);
const EVIDENCE_CLASSES = Object.freeze(["structural_fake", "product_certification"]);
const CHECK_STATES = Object.freeze(["passed", "failed", "not_run", "unavailable"]);
const SAFE_OUTPUT_KEYS = Object.freeze(["credentialsPersisted", "promptsPersisted", "pathsPersisted", "transcriptsPersisted"]);

function validateChecks(value, state, context) {
	const checks = assertPlainObject(value, `${context}.checks`);
	assertExactKeys(checks, CHECK_NAMES, [], `${context}.checks`);
	for (const name of CHECK_NAMES) assertChoice(checks[name], CHECK_STATES, `${context}.checks.${name}`);
	if (state === "passed" && CHECK_NAMES.some((name) => checks[name] !== "passed")) {
		throw new Error(`${context} passed requires every certification check to pass`);
	}
	if (state === "failed" && CHECK_NAMES.every((name) => checks[name] === "passed")) {
		throw new Error(`${context} failed requires at least one failed certification check`);
	}
	if (["not_run", "unavailable"].includes(state) && CHECK_NAMES.some((name) => checks[name] !== state)) {
		throw new Error(`${context} ${state} requires every check to report ${state}`);
	}
	return Object.freeze({ ...checks });
}

function validateSafety(value, context) {
	const safety = assertPlainObject(value, `${context}.safety`);
	assertExactKeys(safety, SAFE_OUTPUT_KEYS, [], `${context}.safety`);
	for (const key of SAFE_OUTPUT_KEYS) {
		if (safety[key] !== false) throw new Error(`${context}.safety.${key} must be false`);
	}
	return Object.freeze({ ...safety });
}

function validateDependency(value, context) {
	if (value === null) return null;
	const dependency = assertPlainObject(value, `${context}.dependency`);
	assertExactKeys(dependency, ["name", "version", "digest"], [], `${context}.dependency`);
	if (typeof dependency.name !== "string" || dependency.name.length < 1 || dependency.name.length > 120) {
		throw new TypeError(`${context}.dependency.name must be bounded`);
	}
	if (typeof dependency.version !== "string" || dependency.version.length < 1 || dependency.version.length > 120) {
		throw new TypeError(`${context}.dependency.version must be an exact bounded identity`);
	}
	assertSha256(dependency.digest, `${context}.dependency.digest`);
	return Object.freeze({ ...dependency });
}

function validateAuthority(value, context) {
	const authority = assertPlainObject(value, `${context}.authority`);
	assertExactKeys(authority, ["kind", "referenceDigest"], [], `${context}.authority`);
	assertChoice(authority.kind, ["none", "explicit_isolated"], `${context}.authority.kind`);
	if (authority.kind === "none" && authority.referenceDigest !== null) {
		throw new Error(`${context} without authorization cannot carry an authorization reference`);
	}
	if (authority.kind === "explicit_isolated") {
		assertSha256(authority.referenceDigest, `${context}.authority.referenceDigest`);
	}
	return Object.freeze({ ...authority });
}

export function validateCertificationRecord(value, context = "certification") {
	const record = assertPlainObject(value, context);
	assertExactKeys(
		record,
		[
			"schemaVersion",
			"type",
			"connector",
			"headSha",
			"evidenceClass",
			"state",
			"reasonCode",
			"platform",
			"dependency",
			"authority",
			"checks",
			"safety",
			"source",
		],
		["digest"],
		context,
	);
	if (record.schemaVersion !== 1 || record.type !== "connector_certification") {
		throw new TypeError(`${context} must be a connector certification schemaVersion 1 record`);
	}
	const connector = assertChoice(record.connector, LINE13_CONNECTORS, `${context}.connector`);
	const headSha = assertFullSha(record.headSha, `${context}.headSha`);
	const evidenceClass = assertChoice(record.evidenceClass, EVIDENCE_CLASSES, `${context}.evidenceClass`);
	const state = assertChoice(record.state, RECORD_STATES, `${context}.state`);
	const reasonCode = assertSafeReasonCode(record.reasonCode, `${context}.reasonCode`);
	const platform = record.platform === null
		? null
		: assertChoice(record.platform, LINE13_PLATFORMS, `${context}.platform`);
	const dependency = validateDependency(record.dependency, context);
	const authority = validateAuthority(record.authority, context);
	const checks = validateChecks(record.checks, state, context);
	const safety = validateSafety(record.safety, context);
	const source = assertChoice(
		record.source,
		["local_fake_harness", "authorized_external_run", "explicit_absence"],
		`${context}.source`,
	);

	if (evidenceClass === "structural_fake") {
		if (source !== "local_fake_harness") throw new Error(`${context} fake evidence must come from the local fake harness`);
		if (authority.kind !== "none") throw new Error(`${context} fake evidence cannot claim authorization`);
		if (dependency !== null) throw new Error(`${context} fake evidence cannot claim an actual dependency identity`);
	}
	if (evidenceClass === "product_certification") {
		if (state === "passed" || state === "failed") {
			if (source !== "authorized_external_run") {
				throw new Error(`${context} executed product certification requires an authorized external run`);
			}
			if (authority.kind !== "explicit_isolated" || dependency === null || platform === null) {
				throw new Error(`${context} executed product certification requires authorization, platform, and dependency identity`);
			}
		} else if (source !== "explicit_absence") {
			throw new Error(`${context} non-passing product certification must be an explicit absence record`);
		} else if (authority.kind !== "none" || dependency !== null || platform !== null) {
			throw new Error(`${context} absent product certification cannot claim authorization, platform, or dependency identity`);
		}
	}
	if (record.digest !== undefined) assertSha256(record.digest, `${context}.digest`);

	const validated = Object.freeze({
		schemaVersion: 1,
		type: "connector_certification",
		connector,
		headSha,
		evidenceClass,
		state,
		reasonCode,
		platform,
		dependency,
		authority,
		checks,
		safety,
		source,
	});
	assertSanitized(validated, context);
	if (record.digest !== undefined && record.digest !== digestJson(validated)) {
		throw new Error(`${context}.digest does not match the record`);
	}
	return Object.freeze({ ...validated, digest: digestJson(validated) });
}

export function createStructuralCertificationRecord({ connector, headSha, platform }) {
	return validateCertificationRecord({
		schemaVersion: 1,
		type: "connector_certification",
		connector,
		headSha,
		evidenceClass: "structural_fake",
		state: "passed",
		reasonCode: "fake_conformance_passed",
		platform,
		dependency: null,
		authority: { kind: "none", referenceDigest: null },
		checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, "passed"])),
		safety: Object.fromEntries(SAFE_OUTPUT_KEYS.map((key) => [key, false])),
		source: "local_fake_harness",
	});
}

export function createAbsentProductCertificationRecord({ connector, headSha, state = "not_run", reasonCode }) {
	if (!new Set(["not_run", "unavailable"]).has(state)) {
		throw new Error("Repository-owned certification generation can create only absent not_run or unavailable states");
	}
	return validateCertificationRecord({
		schemaVersion: 1,
		type: "connector_certification",
		connector,
		headSha,
		evidenceClass: "product_certification",
		state,
		reasonCode,
		platform: null,
		dependency: null,
		authority: { kind: "none", referenceDigest: null },
		checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, state])),
		safety: Object.fromEntries(SAFE_OUTPUT_KEYS.map((key) => [key, false])),
		source: "explicit_absence",
	});
}

function printUsage() {
	console.log(`Usage: node packages/coding-agent/scripts/line13-certification.mjs <command> [options]

Commands:
  structural   Emit fake structural conformance records; never product certification
  absent       Emit explicit not_run/unavailable real-certification states
  validate     Validate records supplied by an authorized certification environment

Common options:
  --head-sha <sha>       Full candidate commit SHA
  --connector <id>       acp, codex_app_server, or claude_agent_sdk; repeatable
  --out <path>           JSON array output

structural options:
  --platform <name>      windows, linux, or macos

absent options:
  --state <state>        not_run or unavailable
  --reason-code <code>   Safe reason code

validate options:
  --input <path>         JSON record or array of records

The repository CLI intentionally cannot mint a passed product-certification
record. Such a record must come from an explicitly authorized isolated run and
must include pinned dependency, platform, safety, and authorization evidence.
`);
}

function selectedConnectors(values) {
	const connectors = values ?? [...LINE13_CONNECTORS];
	return [...new Set(connectors.map((connector) => assertChoice(connector, LINE13_CONNECTORS, "--connector")))];
}

function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (command === undefined || command === "--help") {
		printUsage();
		return;
	}
	const args = parseFlagArguments(rest, {
		"--head-sha": "value",
		"--connector": "repeatable",
		"--platform": "value",
		"--state": "value",
		"--reason-code": "value",
		"--input": "value",
		"--out": "value",
		"--help": "boolean",
	});
	if (args["--help"] === true) {
		printUsage();
		return;
	}
	if (args["--out"] === undefined) throw new Error("--out is required");
	let records;
	if (command === "structural") {
		if (args["--head-sha"] === undefined || args["--platform"] === undefined) {
			throw new Error("structural requires --head-sha and --platform");
		}
		records = selectedConnectors(args["--connector"]).map((connector) =>
			createStructuralCertificationRecord({
				connector,
				headSha: args["--head-sha"],
				platform: args["--platform"],
			}),
		);
	} else if (command === "absent") {
		if (args["--head-sha"] === undefined || args["--state"] === undefined || args["--reason-code"] === undefined) {
			throw new Error("absent requires --head-sha, --state, and --reason-code");
		}
		records = selectedConnectors(args["--connector"]).map((connector) =>
			createAbsentProductCertificationRecord({
				connector,
				headSha: args["--head-sha"],
				state: args["--state"],
				reasonCode: args["--reason-code"],
			}),
		);
	} else if (command === "validate") {
		if (args["--input"] === undefined) throw new Error("validate requires --input");
		const input = readJson(args["--input"]);
		records = (Array.isArray(input) ? input : [input]).map((record, index) =>
			validateCertificationRecord(record, `certifications[${index}]`),
		);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
	writeJsonAtomic(args["--out"], records);
	console.log(`Wrote ${records.length} connector certification record(s)`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
