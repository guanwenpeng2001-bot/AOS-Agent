#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { join } from "node:path";
import {
	LINE13_ACCEPTANCE_CRITERIA,
	LINE13_CONNECTORS,
	LINE13_PLATFORMS,
	LINE13_REQUIRED_CHECKS,
	LINE13_RUNTIME_KINDS,
	LINE13_QUALITY_GATES,
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
import {
	LINE13_SOAK_OPERATION_PLAN,
	LINE13_SOAK_RESOURCE_NAMES,
} from "../packages/coding-agent/scripts/line13-soak.mjs";

const PASS_STATE = "passed";
const FORBIDDEN_FINAL_STATES = new Set(["cancelled", "partial", "pending"]);

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
			"operations",
			"canonicalOwners",
			"resources",
			"provider",
			"safety",
			"digest",
		],
		[],
		context,
	);
	if (soak.type !== "soak" || soak.schemaVersion !== 2) throw new Error(`${context} has the wrong schema`);
	if (assertFullSha(soak.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (soak.platform !== platform || soak.state !== PASS_STATE || soak.evidenceClass !== "product_trace") {
		throw new Error(`${context} is not a packaged standard product trace for ${platform}`);
	}
	if (!Number.isSafeInteger(soak.iterations) || soak.iterations < LINE13_SOAK_OPERATION_PLAN.length) {
		throw new Error(`${context}.iterations is invalid`);
	}
	if (!Number.isSafeInteger(soak.plateauWindow) || soak.plateauWindow < 2 || soak.plateauWindow > soak.iterations) {
		throw new Error(`${context}.plateauWindow is invalid`);
	}
	const operations = assertPlainObject(soak.operations, `${context}.operations`);
	assertExactKeys(operations, LINE13_SOAK_OPERATION_PLAN, [], `${context}.operations`);
	for (const operation of LINE13_SOAK_OPERATION_PLAN) {
		if (!Number.isSafeInteger(operations[operation]) || operations[operation] < 1) {
			throw new Error(`${context} did not invoke product ${operation}`);
		}
	}
	if (Object.values(operations).reduce((total, count) => total + count, 0) !== soak.iterations) {
		throw new Error(`${context}.operations does not cover every product iteration`);
	}
	if (!Array.isArray(soak.canonicalOwners) || soak.canonicalOwners.length !== 7 || new Set(soak.canonicalOwners).size !== 7) {
		throw new Error(`${context} did not read closure from every canonical owner`);
	}
	const resources = assertPlainObject(soak.resources, `${context}.resources`);
	assertExactKeys(resources, ["final", "plateauSamples", "plateauDigest"], [], `${context}.resources`);
	const finalResources = assertPlainObject(resources.final, `${context}.resources.final`);
	assertExactKeys(finalResources, LINE13_SOAK_RESOURCE_NAMES, [], `${context}.resources.final`);
	for (const name of LINE13_SOAK_RESOURCE_NAMES) {
		const value = finalResources[name];
		if (!Number.isSafeInteger(value) || value < 0 || (name === "files" ? value > 1 : value !== 0)) {
			throw new Error(`${context} retained ${name}=${value}`);
		}
	}
	if (resources.plateauSamples !== soak.plateauWindow) {
		throw new Error(`${context} does not contain a bounded plateau window`);
	}
	assertSha256(resources.plateauDigest, `${context}.resources.plateauDigest`);
	const provider = assertPlainObject(soak.provider, `${context}.provider`);
	assertExactKeys(provider, ["kind", "pendingResponses"], [], `${context}.provider`);
	if (provider.kind !== "faux" || provider.pendingResponses !== 0) {
		throw new Error(`${context} retained faux responses`);
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
			"entrypoints",
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
	if (upgrade.type !== "upgrade" || upgrade.schemaVersion !== 2) throw new Error(`${context} has the wrong schema`);
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
	const entrypoints = assertPlainObject(upgrade.entrypoints, `${context}.entrypoints`);
	assertExactKeys(entrypoints, ["previous", "candidate"], [], `${context}.entrypoints`);
	if (entrypoints.previous !== "aos-agent" || entrypoints.candidate !== "aos-agent/external-connector") {
		throw new Error(`${context} did not invoke the installed package entrypoints`);
	}
	for (const name of ["previousPackage", "candidatePackage"]) {
		const packageRecord = assertPlainObject(upgrade[name], `${context}.${name}`);
		assertExactKeys(packageRecord, ["name", "version", "digest"], [], `${context}.${name}`);
		if (packageRecord.name !== "aos-agent" || typeof packageRecord.version !== "string") {
			throw new Error(`${context}.${name} has an invalid package identity`);
		}
		assertSha256(packageRecord.digest, `${context}.${name}.digest`);
	}
	const versionParts = (version) => version.split("-", 1)[0].split(".").map(Number);
	const previousParts = versionParts(upgrade.previousPackage.version);
	const candidateParts = versionParts(upgrade.candidatePackage.version);
	if (previousParts.length !== 3 || candidateParts.length !== 3) {
		throw new Error(`${context} package version is invalid`);
	}
	let versionDifference = 0;
	for (let index = 0; index < 3 && versionDifference === 0; index += 1) {
		if (!Number.isSafeInteger(previousParts[index]) || !Number.isSafeInteger(candidateParts[index])) {
			throw new Error(`${context} package version is invalid`);
		}
		versionDifference = previousParts[index] - candidateParts[index];
	}
	if (versionDifference >= 0) throw new Error(`${context} previous package is not older than the candidate`);
	if (!Array.isArray(upgrade.scenarios) || upgrade.scenarios.length !== 2) {
		throw new Error(`${context}.scenarios must contain exactly both interruption points`);
	}
	const scenarios = new Set();
	for (const [index, value_] of upgrade.scenarios.entries()) {
		const scenario = assertPlainObject(value_, `${context}.scenarios[${index}]`);
		assertExactKeys(scenario, ["fault", "recoveredSchemaVersion", "finalSchemaVersion", "stateDigest"], [], `${context}.scenarios[${index}]`);
		if (!["before_publish", "after_publish"].includes(scenario.fault) || scenarios.has(scenario.fault)) {
			throw new Error(`${context}.scenarios has an invalid or duplicate fault`);
		}
		scenarios.add(scenario.fault);
		const expectedRecovered = scenario.fault === "before_publish" ? 1 : 2;
		if (scenario.recoveredSchemaVersion !== expectedRecovered || scenario.finalSchemaVersion !== 2) {
			throw new Error(`${context}.${scenario.fault} did not recover an atomic migration`);
		}
		assertSha256(scenario.stateDigest, `${context}.${scenario.fault}.stateDigest`);
	}
	for (const fault of ["before_publish", "after_publish"]) {
		if (!scenarios.has(fault)) throw new Error(`${context} is missing ${fault}`);
	}
	if (upgrade.cleanup !== true) throw new Error(`${context} did not clean its owned installation state`);
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

function validateEvidenceIdentity(value, context) {
	const identity = assertPlainObject(value, context);
	assertExactKeys(identity, ["id", "digest"], [], context);
	if (typeof identity.id !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,159}$/u.test(identity.id)) {
		throw new TypeError(`${context}.id must be a stable artifact identity`);
	}
	assertSha256(identity.digest, `${context}.digest`);
	return identity;
}

function assertPositiveInteger(value, context) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${context} must be a positive safe integer`);
	return value;
}

function parsePositiveInteger(value, context) {
	if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
		throw new TypeError(`${context} must be a positive integer`);
	}
	return assertPositiveInteger(Number(value), context);
}

function validateWorkflowPath(value, context) {
	if (typeof value !== "string" || !/^\.github\/workflows\/[^/@]+\.ya?ml$/u.test(value)) {
		throw new TypeError(`${context} must identify a repository workflow file`);
	}
	return value;
}

function validateCiProvenance(value, expectedHead, expectedBase, expectedWorkflow, context) {
	const provenance = assertPlainObject(value, context);
	assertExactKeys(
		provenance,
		["schemaVersion", "type", "source", "repository", "baseSha", "headSha", "workflow", "run", "artifact", "digest"],
		[],
		context,
	);
	if (provenance.schemaVersion !== 1 || provenance.type !== "ci_provenance" || provenance.source !== "github_actions_api") {
		throw new Error(`${context} is not GitHub Actions API provenance`);
	}
	if (typeof provenance.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(provenance.repository)) {
		throw new TypeError(`${context}.repository must be an owner/repository name`);
	}
	if (assertFullSha(provenance.baseSha, `${context}.baseSha`) !== expectedBase) throw new Error(`${context} has a stale base`);
	if (assertFullSha(provenance.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} has a stale head`);

	const workflow = assertPlainObject(provenance.workflow, `${context}.workflow`);
	assertExactKeys(workflow, ["id", "path"], [], `${context}.workflow`);
	assertPositiveInteger(workflow.id, `${context}.workflow.id`);
	if (validateWorkflowPath(workflow.path, `${context}.workflow.path`) !== expectedWorkflow) {
		throw new Error(`${context} came from the wrong workflow`);
	}

	const run = assertPlainObject(provenance.run, `${context}.run`);
	assertExactKeys(run, ["id", "workflowId", "headSha", "status", "conclusion", "cancelled"], [], `${context}.run`);
	assertPositiveInteger(run.id, `${context}.run.id`);
	if (assertPositiveInteger(run.workflowId, `${context}.run.workflowId`) !== workflow.id) {
		throw new Error(`${context}.run belongs to a different workflow`);
	}
	if (assertFullSha(run.headSha, `${context}.run.headSha`) !== expectedHead) throw new Error(`${context}.run has a stale head`);
	if (run.status !== "completed" || run.conclusion !== "success" || run.cancelled !== false) {
		throw new Error(`${context}.run is failed, cancelled, or incomplete`);
	}

	const artifact = assertPlainObject(provenance.artifact, `${context}.artifact`);
	assertExactKeys(artifact, ["id", "name", "runId", "headSha", "digest", "expired"], [], `${context}.artifact`);
	assertPositiveInteger(artifact.id, `${context}.artifact.id`);
	if (typeof artifact.name !== "string" || artifact.name.length < 1 || artifact.name.length > 255) {
		throw new TypeError(`${context}.artifact.name must be non-empty`);
	}
	if (assertPositiveInteger(artifact.runId, `${context}.artifact.runId`) !== run.id) {
		throw new Error(`${context}.artifact belongs to a different run`);
	}
	if (assertFullSha(artifact.headSha, `${context}.artifact.headSha`) !== expectedHead) {
		throw new Error(`${context}.artifact has a stale head`);
	}
	assertSha256(artifact.digest, `${context}.artifact.digest`);
	if (artifact.expired !== false) throw new Error(`${context}.artifact is expired`);
	assertSha256(provenance.digest, `${context}.digest`);
	const unsigned = { ...provenance };
	delete unsigned.digest;
	if (provenance.digest !== digestJson(unsigned)) throw new Error(`${context}.digest does not match its API attestation`);
	return provenance;
}

function validateCiArtifactReference(value, provenance, context) {
	const reference = assertPlainObject(value, context);
	assertExactKeys(reference, ["runId", "artifactId", "digest"], [], context);
	if (assertPositiveInteger(reference.runId, `${context}.runId`) !== provenance.run.id) {
		throw new Error(`${context} belongs to a different workflow run`);
	}
	if (assertPositiveInteger(reference.artifactId, `${context}.artifactId`) !== provenance.artifact.id) {
		throw new Error(`${context} identifies a different artifact`);
	}
	assertSha256(reference.digest, `${context}.digest`);
	if (reference.digest !== provenance.artifact.digest) throw new Error(`${context}.digest does not match the attested artifact`);
	return reference;
}

export function createCiProvenanceRecord({
	repository,
	expectedHead,
	expectedBase,
	expectedWorkflow,
	expectedRunId,
	expectedArtifactId,
	expectedArtifactName,
	run: runValue,
	workflow: workflowValue,
	artifact: artifactValue,
}) {
	const run = assertPlainObject(runValue, "runMetadata");
	const workflow = assertPlainObject(workflowValue, "workflowMetadata");
	const artifact = assertPlainObject(artifactValue, "artifactMetadata");
	const runId = assertPositiveInteger(expectedRunId, "expectedRunId");
	const artifactId = assertPositiveInteger(expectedArtifactId, "expectedArtifactId");
	const headSha = assertFullSha(expectedHead, "expectedHead");
	const baseSha = assertFullSha(expectedBase, "expectedBase");
	const workflowPath = validateWorkflowPath(expectedWorkflow, "expectedWorkflow");
	if (run.id !== runId) throw new Error("GitHub run metadata does not match the requested run ID");
	if (run.head_sha !== headSha) throw new Error("GitHub run metadata has a stale head");
	if (run.status !== "completed" || run.conclusion !== "success") {
		throw new Error("GitHub workflow run is failed, cancelled, or incomplete");
	}
	if (workflow.id !== run.workflow_id || workflow.path !== workflowPath) {
		throw new Error("GitHub workflow run identity does not match the expected workflow");
	}
	if (artifact.id !== artifactId || artifact.name !== expectedArtifactName) {
		throw new Error("GitHub artifact metadata does not match the requested artifact");
	}
	if (artifact.expired !== false) throw new Error("GitHub artifact is expired");
	assertSha256(artifact.digest, "artifactMetadata.digest");
	const artifactRun = assertPlainObject(artifact.workflow_run, "artifactMetadata.workflow_run");
	if (artifactRun.id !== runId) throw new Error("GitHub artifact belongs to a different workflow run");
	if (artifactRun.head_sha !== headSha) throw new Error("GitHub artifact has a stale head");
	const unsigned = {
		schemaVersion: 1,
		type: "ci_provenance",
		source: "github_actions_api",
		repository,
		baseSha,
		headSha,
		workflow: { id: workflow.id, path: workflow.path },
		run: {
			id: run.id,
			workflowId: run.workflow_id,
			headSha: run.head_sha,
			status: run.status,
			conclusion: run.conclusion,
			cancelled: run.conclusion === "cancelled",
		},
		artifact: {
			id: artifact.id,
			name: artifact.name,
			runId: artifactRun.id,
			headSha: artifactRun.head_sha,
			digest: artifact.digest,
			expired: artifact.expired,
		},
	};
	return Object.freeze(validateCiProvenance(
		{ ...unsigned, digest: digestJson(unsigned) },
		headSha,
		baseSha,
		workflowPath,
		"ciProvenance",
	));
}

function validateInputDigest(record, context) {
	assertSha256(record.inputDigest, `${context}.inputDigest`);
	const unsigned = { ...record };
	delete unsigned.inputDigest;
	if (record.inputDigest !== digestJson(unsigned)) throw new Error(`${context}.inputDigest drifted`);
}

function resolveGitMilestoneCommitChain(expectedBase, expectedHead) {
	const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", expectedBase, expectedHead], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (ancestor.status !== 0) throw new Error("Requested milestone base is not an ancestor of the requested head");
	const result = spawnSync("git", ["rev-list", "--first-parent", "--reverse", `${expectedBase}..${expectedHead}`], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error("Could not resolve the repository milestone commit chain");
	const commits = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((sha, index) =>
		assertFullSha(sha, `gitMilestoneChain[${index}]`));
	if (commits.length < 1 || commits.at(-1) !== expectedHead) {
		throw new Error("Repository milestone chain does not terminate at the requested head");
	}
	return commits;
}

function validateMilestoneChain(value, expectedBase, expectedHead, expectedCommits, provenance, context) {
	const chain = assertPlainObject(value, context);
	assertExactKeys(chain, ["schemaVersion", "type", "baseSha", "headSha", "state", "commits", "inputDigest"], [], context);
	if (chain.schemaVersion !== 2 || chain.type !== "milestone_chain" || chain.state !== PASS_STATE) {
		throw new Error(`${context} is not a passed milestone chain`);
	}
	if (assertFullSha(chain.baseSha, `${context}.baseSha`) !== expectedBase) throw new Error(`${context} has a stale base`);
	if (assertFullSha(chain.headSha, `${context}.headSha`) !== expectedHead) throw new Error(`${context} is stale`);
	if (!Array.isArray(chain.commits) || chain.commits.length < 1) throw new Error(`${context}.commits is incomplete`);
	if (chain.commits.length !== expectedCommits.length) throw new Error(`${context}.commits has a base-to-head gap`);
	const seen = new Set();
	let parentSha = expectedBase;
	for (const [index, value_] of chain.commits.entries()) {
		const commit = assertPlainObject(value_, `${context}.commits[${index}]`);
		assertExactKeys(commit, ["sequence", "commitSha", "parentSha", "gate", "inputDigest"], [], `${context}.commits[${index}]`);
		if (commit.sequence !== index + 1) throw new Error(`${context}.commits has a sequence gap`);
		const commitSha = assertFullSha(commit.commitSha, `${context}.commits[${index}].commitSha`);
		if (commitSha !== expectedCommits[index]) throw new Error(`${context}.commits[${index}] does not match repository history`);
		if (seen.has(commitSha)) throw new Error(`${context}.commits contains duplicate ${commitSha}`);
		seen.add(commitSha);
		if (assertFullSha(commit.parentSha, `${context}.commits[${index}].parentSha`) !== parentSha) {
			throw new Error(`${context}.commits[${index}] parent continuity mismatch`);
		}
		const gate = assertPlainObject(commit.gate, `${context}.commits[${index}].gate`);
		assertExactKeys(gate, ["state", "cancelled", "command", "ciArtifact"], [], `${context}.commits[${index}].gate`);
		if (gate.state !== PASS_STATE || gate.cancelled !== false) {
			throw new Error(`${context}.commits[${index}] gate is cancelled, pending, or non-passing`);
		}
		validateEvidenceIdentity(gate.command, `${context}.commits[${index}].gate.command`);
		validateCiArtifactReference(gate.ciArtifact, provenance, `${context}.commits[${index}].gate.ciArtifact`);
		validateInputDigest(commit, `${context}.commits[${index}]`);
		parentSha = commitSha;
	}
	if (parentSha !== expectedHead) throw new Error(`${context}.commits does not terminate at the requested head`);
	validateInputDigest(chain, context);
	return chain;
}

function validateAcOwnerTransitions(value, expectedBase, expectedHead, chain, context) {
	const evidence = assertPlainObject(value, context);
	assertExactKeys(evidence, ["schemaVersion", "type", "baseSha", "headSha", "state", "transitions", "inputDigest"], [], context);
	if (evidence.schemaVersion !== 1 || evidence.type !== "ac_owner_transitions" || evidence.state !== PASS_STATE) {
		throw new Error(`${context} is not a passed AC owner transition set`);
	}
	if (evidence.baseSha !== expectedBase || evidence.headSha !== expectedHead) throw new Error(`${context} is stale`);
	if (!Array.isArray(evidence.transitions) || evidence.transitions.length !== LINE13_ACCEPTANCE_CRITERIA.length) {
		throw new Error(`${context} must contain AC-01 through AC-24 exactly once`);
	}
	assertUniqueBy(evidence.transitions, (transition) => transition.id, context);
	const commits = new Set(chain.commits.map((commit) => commit.commitSha));
	for (const id of LINE13_ACCEPTANCE_CRITERIA) {
		const transition = evidence.transitions.find((candidate) => candidate.id === id);
		if (transition === undefined) throw new Error(`${context} is missing ${id}`);
		const record = assertPlainObject(transition, `${context}.${id}`);
		assertExactKeys(record, ["id", "from", "to", "owner", "commitSha", "headSha", "state", "inputDigest"], [], `${context}.${id}`);
		if (
			record.from !== "open" ||
			record.to !== "closed" ||
			record.state !== PASS_STATE ||
			record.headSha !== expectedHead ||
			typeof record.owner !== "string" ||
			!/^[a-z][a-z0-9._-]{0,79}$/u.test(record.owner) ||
			!commits.has(record.commitSha)
		) throw new Error(`${context}.${id} is stale or has an invalid owner transition`);
		validateInputDigest(record, `${context}.${id}`);
	}
	validateInputDigest(evidence, context);
	return evidence;
}

function validateQualityGates(value, expectedHead, provenance, context) {
	const evidence = assertPlainObject(value, context);
	assertExactKeys(evidence, ["schemaVersion", "type", "headSha", "state", "gates", "inputDigest"], [], context);
	if (evidence.schemaVersion !== 2 || evidence.type !== "quality_gates" || evidence.state !== PASS_STATE) {
		throw new Error(`${context} is not a passed Q0-Q18 evidence set`);
	}
	if (evidence.headSha !== expectedHead) throw new Error(`${context} is stale`);
	if (!Array.isArray(evidence.gates) || evidence.gates.length !== LINE13_QUALITY_GATES.length) {
		throw new Error(`${context} must contain Q0 through Q18 exactly once`);
	}
	assertUniqueBy(evidence.gates, (gate) => gate.id, context);
	for (const id of LINE13_QUALITY_GATES) {
		const gate = evidence.gates.find((candidate) => candidate.id === id);
		if (gate === undefined) throw new Error(`${context} is missing ${id}`);
		const record = assertPlainObject(gate, `${context}.${id}`);
		assertExactKeys(record, ["id", "headSha", "state", "cancelled", "command", "ciArtifact", "inputDigest"], [], `${context}.${id}`);
		if (record.headSha !== expectedHead || record.state !== PASS_STATE || record.cancelled !== false) {
			throw new Error(`${context}.${id} is stale, cancelled, pending, or non-passing`);
		}
		validateEvidenceIdentity(record.command, `${context}.${id}.command`);
		validateCiArtifactReference(record.ciArtifact, provenance, `${context}.${id}.ciArtifact`);
		validateInputDigest(record, `${context}.${id}`);
	}
	validateInputDigest(evidence, context);
	return evidence;
}

export function validateLine13EvidenceManifest(value, expectedHead, expectedBase, expectedWorkflow, expectedCommitChain) {
	const manifest = assertPlainObject(value, "manifest");
	assertExactKeys(
		manifest,
		[
			"schemaVersion",
			"type",
			"headSha",
			"baseSha",
			"requestedHeadSha",
			"state",
			"ciProvenance",
			"milestoneChain",
			"acOwnerTransitions",
			"qualityGates",
			"knownGaps",
			"platforms",
			"certifications",
			"createdBy",
		],
		["digest"],
		"manifest",
	);
	if (manifest.schemaVersion !== 2 || manifest.type !== "line13_final_evidence") {
		throw new Error("manifest has the wrong schema");
	}
	const headSha = assertFullSha(manifest.headSha, "manifest.headSha");
	const baseSha = assertFullSha(manifest.baseSha, "manifest.baseSha");
	const requestedHeadSha = assertFullSha(manifest.requestedHeadSha, "manifest.requestedHeadSha");
	if (headSha !== requestedHeadSha || headSha !== assertFullSha(expectedHead, "expectedHead")) {
		throw new Error("manifest is stale or mixes requested and checked-out heads");
	}
	if (baseSha !== assertFullSha(expectedBase, "expectedBase") || baseSha === headSha) {
		throw new Error("manifest base is stale or does not precede the requested head");
	}
	const milestoneCommits = expectedCommitChain ?? resolveGitMilestoneCommitChain(baseSha, headSha);
	if (!Array.isArray(milestoneCommits) || milestoneCommits.length < 1) {
		throw new Error("Expected milestone commit chain is empty");
	}
	milestoneCommits.forEach((sha, index) => assertFullSha(sha, `expectedCommitChain[${index}]`));
	if (manifest.state !== PASS_STATE || manifest.createdBy !== "repository_verifier") {
		throw new Error("manifest is not a completed repository-verifier record");
	}
	rejectCancelledOrPartial(manifest, "manifest");
	const workflowPath = validateWorkflowPath(expectedWorkflow, "expectedWorkflow");
	const provenance = validateCiProvenance(manifest.ciProvenance, headSha, baseSha, workflowPath, "manifest.ciProvenance");
	const milestoneChain = validateMilestoneChain(
		manifest.milestoneChain,
		baseSha,
		headSha,
		milestoneCommits,
		provenance,
		"manifest.milestoneChain",
	);
	validateAcOwnerTransitions(
		manifest.acOwnerTransitions,
		baseSha,
		headSha,
		milestoneChain,
		"manifest.acOwnerTransitions",
	);
	validateQualityGates(manifest.qualityGates, headSha, provenance, "manifest.qualityGates");
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

export function assembleLine13EvidenceManifest(records, expectedHead, expectedBase, expectedWorkflow, expectedCommitChain) {
	const headSha = assertFullSha(expectedHead, "expectedHead");
	const baseSha = assertFullSha(expectedBase, "expectedBase");
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
		schemaVersion: 2,
		type: "line13_final_evidence",
		headSha,
		baseSha,
		requestedHeadSha: headSha,
		state: "passed",
		ciProvenance: exactlyOne(records, "ci_provenance"),
		milestoneChain: exactlyOne(records, "milestone_chain"),
		acOwnerTransitions: exactlyOne(records, "ac_owner_transitions"),
		qualityGates: exactlyOne(records, "quality_gates"),
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
	return validateLine13EvidenceManifest(manifest, headSha, baseSha, expectedWorkflow, expectedCommitChain);
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
  --record-ci-provenance  Validate GitHub API metadata and emit its attestation

Common:
  --expected-head <sha>   Full requested candidate SHA (required)
  --expected-base <sha>   Full base SHA before the milestone chain (final modes)
  --expected-workflow <path>  Exact source workflow path (final/provenance modes)
  --out <path>            Output for assembly or record generation

--record-job:
  --platform <name>       windows, linux, or macos
  --checked-out-start <sha>
  --checked-out-final <sha>
  --state passed
  --check <id>            Repeat for every required T9/T10 check

--record-ci-provenance:
  --repository <owner/repo>
  --run-metadata <path>       GitHub Actions run API response
  --workflow-metadata <path>  GitHub Actions workflow API response
  --artifact-metadata <path>  GitHub Actions artifact API response
  --expected-run-id <id>
  --expected-artifact-id <id>
  --expected-artifact-name <name>

The verifier rejects stale or mixed heads, cancelled/partial records, nonzero
known gaps, unbound or failed CI artifacts, missing native OS/runtime evidence,
offline upgrade fixtures, and fake records used as real product certification.
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
		"--record-ci-provenance": "boolean",
		"--expected-head": "value",
		"--expected-base": "value",
		"--expected-workflow": "value",
		"--repository": "value",
		"--run-metadata": "value",
		"--workflow-metadata": "value",
		"--artifact-metadata": "value",
		"--expected-run-id": "value",
		"--expected-artifact-id": "value",
		"--expected-artifact-name": "value",
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
	if (args["--record-ci-provenance"] === true) {
		const record = createCiProvenanceRecord({
			repository: required(args, "--repository"),
			expectedHead,
			expectedBase: required(args, "--expected-base"),
			expectedWorkflow: required(args, "--expected-workflow"),
			expectedRunId: parsePositiveInteger(required(args, "--expected-run-id"), "--expected-run-id"),
			expectedArtifactId: parsePositiveInteger(required(args, "--expected-artifact-id"), "--expected-artifact-id"),
			expectedArtifactName: required(args, "--expected-artifact-name"),
			run: readJson(required(args, "--run-metadata")),
			workflow: readJson(required(args, "--workflow-metadata")),
			artifact: readJson(required(args, "--artifact-metadata")),
		});
		writeJsonAtomic(required(args, "--out"), record);
		return;
	}
	if (args["--manifest"] !== undefined) {
		const manifest = validateLine13EvidenceManifest(
			readJson(args["--manifest"]),
			expectedHead,
			required(args, "--expected-base"),
			required(args, "--expected-workflow"),
		);
		console.log(`Line 13 exact-head evidence verified: ${manifest.digest}`);
		return;
	}
	if (args["--records-dir"] !== undefined) {
		const manifest = assembleLine13EvidenceManifest(
			collectJsonRecords(args["--records-dir"]),
			expectedHead,
			required(args, "--expected-base"),
			required(args, "--expected-workflow"),
		);
		writeJsonAtomic(required(args, "--out"), manifest);
		console.log(`Line 13 exact-head evidence assembled and verified: ${manifest.digest}`);
		return;
	}
	throw new Error("Select --manifest, --records-dir, --record-job, or --record-ci-provenance; use --help for arguments");
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
