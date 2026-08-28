import assert from "node:assert/strict";
import test from "node:test";
import {
	LINE13_ACCEPTANCE_CRITERIA,
	LINE13_CONNECTORS,
	LINE13_PLATFORMS,
	LINE13_REQUIRED_CHECKS,
	LINE13_RUNTIME_KINDS,
	LINE13_QUALITY_GATES,
	digestJson,
} from "../packages/coding-agent/scripts/line13-evidence-common.mjs";
import {
	createAbsentProductCertificationRecord,
	createStructuralCertificationRecord,
	validateCertificationRecord,
} from "../packages/coding-agent/scripts/line13-certification.mjs";
import {
	LINE13_SOAK_OPERATION_PLAN,
	LINE13_SOAK_RESOURCE_NAMES,
} from "../packages/coding-agent/scripts/line13-soak.mjs";
import {
	assembleLine13EvidenceManifest,
	createCiProvenanceRecord,
	createNativeJobRecord,
	validateLine13EvidenceManifest,
} from "./verify-line13-evidence.mjs";

const HEAD_SHA = "a".repeat(40);
const OTHER_HEAD_SHA = "b".repeat(40);
const BASE_SHA = "0".repeat(40);
const MIDDLE_SHA = "c".repeat(40);
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_ID = 101;
const RUN_ID = 202;
const ARTIFACT_ID = 303;
const ARTIFACT_NAME = "line13-milestone-evidence";
const ARTIFACT_DIGEST = `sha256:${"9".repeat(64)}`;

function withInputDigest(value) {
	return { ...value, inputDigest: digestJson(value) };
}

function identity(id, character) {
	return { id, digest: `sha256:${character.repeat(64)}` };
}

function ciArtifactReference() {
	return { runId: RUN_ID, artifactId: ARTIFACT_ID, digest: ARTIFACT_DIGEST };
}

function ciProvenance(overrides = {}) {
	return createCiProvenanceRecord({
		repository: "aos-agent/aos-agent",
		expectedHead: HEAD_SHA,
		expectedBase: BASE_SHA,
		expectedWorkflow: WORKFLOW_PATH,
		expectedRunId: RUN_ID,
		expectedArtifactId: ARTIFACT_ID,
		expectedArtifactName: ARTIFACT_NAME,
		run: {
			id: RUN_ID,
			workflow_id: WORKFLOW_ID,
			head_sha: HEAD_SHA,
			status: "completed",
			conclusion: "success",
			...overrides.run,
		},
		workflow: { id: WORKFLOW_ID, path: WORKFLOW_PATH, ...overrides.workflow },
		artifact: {
			id: ARTIFACT_ID,
			name: ARTIFACT_NAME,
			digest: ARTIFACT_DIGEST,
			expired: false,
			workflow_run: { id: RUN_ID, head_sha: HEAD_SHA },
			...overrides.artifact,
		},
	});
}

function milestoneRecords() {
	const commits = [
		withInputDigest({
			sequence: 1,
			commitSha: MIDDLE_SHA,
			parentSha: BASE_SHA,
			gate: { state: "passed", cancelled: false, command: identity("check.middle", "1"), ciArtifact: ciArtifactReference() },
		}),
		withInputDigest({
			sequence: 2,
			commitSha: HEAD_SHA,
			parentSha: MIDDLE_SHA,
			gate: { state: "passed", cancelled: false, command: identity("check.head", "3"), ciArtifact: ciArtifactReference() },
		}),
	];
	const milestone = withInputDigest({
		schemaVersion: 2,
		type: "milestone_chain",
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		state: "passed",
		commits,
	});
	const transitions = LINE13_ACCEPTANCE_CRITERIA.map((id) => withInputDigest({
		id,
		from: "open",
		to: "closed",
		owner: "repository",
		commitSha: HEAD_SHA,
		headSha: HEAD_SHA,
		state: "passed",
	}));
	const ac = withInputDigest({
		schemaVersion: 1,
		type: "ac_owner_transitions",
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		state: "passed",
		transitions,
	});
	const gates = LINE13_QUALITY_GATES.map((id, index) => withInputDigest({
		id,
		headSha: HEAD_SHA,
		state: "passed",
		cancelled: false,
		command: identity(`command.${id.toLowerCase()}`, String((index % 8) + 1)),
		ciArtifact: ciArtifactReference(),
	}));
	const quality = withInputDigest({ schemaVersion: 2, type: "quality_gates", headSha: HEAD_SHA, state: "passed", gates });
	return [milestone, ac, quality];
}

function packageSmoke(platform) {
	const evidence = {
		schemaVersion: 1,
		type: "package_smoke",
		headSha: HEAD_SHA,
		platform,
		state: "passed",
		evidenceClass: "packaged_execution",
		outsideRepository: true,
		runtimes: LINE13_RUNTIME_KINDS.map((runtime, index) => ({
			runtime,
			headSha: HEAD_SHA,
			state: "passed",
			digest: `sha256:${String(index + 1).repeat(64)}`,
		})),
	};
	return { ...evidence, digest: digestJson(evidence) };
}

function upgrade(platform) {
	const evidence = {
		schemaVersion: 2,
		type: "upgrade",
		headSha: HEAD_SHA,
		platform,
		state: "passed",
		evidenceClass: "packaged_execution",
		entrypoints: { previous: "aos-agent", candidate: "aos-agent/external-connector" },
		previousPackage: { name: "aos-agent", version: "0.84.2", digest: `sha256:${"4".repeat(64)}` },
		candidatePackage: { name: "aos-agent", version: "0.84.3", digest: `sha256:${"5".repeat(64)}` },
		outsideRepository: true,
		scenarios: [
			{ fault: "before_publish", recoveredSchemaVersion: 1, finalSchemaVersion: 2, stateDigest: `sha256:${"6".repeat(64)}` },
			{ fault: "after_publish", recoveredSchemaVersion: 2, finalSchemaVersion: 2, stateDigest: `sha256:${"7".repeat(64)}` },
		],
		restartValidated: true,
		idempotentMigration: true,
		secretsPersisted: false,
		cleanup: true,
	};
	return { ...evidence, digest: digestJson(evidence) };
}

function soak(platform) {
	const final = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, name === "files" ? 1 : 0]));
	const evidence = {
		schemaVersion: 2,
		type: "soak",
		headSha: HEAD_SHA,
		platform,
		state: "passed",
		evidenceClass: "product_trace",
		iterations: 28,
		plateauWindow: 7,
		operations: Object.fromEntries(LINE13_SOAK_OPERATION_PLAN.map((operation) => [operation, 4])),
		canonicalOwners: ["agent_harness", "external_connector_registry", "task_credential_service", "scheduler_selection_reservations", "worker_registry", "scheduler_status", "session_manager"],
		resources: { final, plateauSamples: 7, plateauDigest: `sha256:${"8".repeat(64)}` },
		provider: { kind: "faux", pendingResponses: 0 },
		safety: { credentialsPersisted: false, rawPayloadPersisted: false, pathsPersisted: false },
	};
	return { ...evidence, digest: digestJson(evidence) };
}

function validManifest() {
	const records = [{
		schemaVersion: 1,
		type: "known_gaps",
		headSha: HEAD_SHA,
		state: "passed",
		count: 0,
		totalAcceptanceCriteria: 24,
	}, ciProvenance(), ...milestoneRecords()];
	for (const platform of LINE13_PLATFORMS) {
		records.push(createNativeJobRecord({
			headSha: HEAD_SHA,
			platform,
			checkedOutStart: HEAD_SHA,
			checkedOutBeforeUpload: HEAD_SHA,
			state: "passed",
			checks: LINE13_REQUIRED_CHECKS,
		}));
		records.push(packageSmoke(platform));
		records.push(soak(platform));
		records.push(upgrade(platform));
		for (const connector of LINE13_CONNECTORS) {
			records.push(createStructuralCertificationRecord({ connector, headSha: HEAD_SHA, platform }));
		}
	}
	for (const connector of LINE13_CONNECTORS) {
		records.push(createAbsentProductCertificationRecord({
			connector,
			headSha: HEAD_SHA,
			state: "not_run",
			reasonCode: "authorized_run_not_provided",
		}));
	}
	return assembleLine13EvidenceManifest(records, HEAD_SHA, BASE_SHA, WORKFLOW_PATH, [MIDDLE_SHA, HEAD_SHA]);
}

function rejectMutation(mutate, pattern) {
	const manifest = structuredClone(validManifest());
	delete manifest.digest;
	mutate(manifest);
	assert.throws(
		() => validateLine13EvidenceManifest(manifest, HEAD_SHA, BASE_SHA, WORKFLOW_PATH, [MIDDLE_SHA, HEAD_SHA]),
		pattern,
	);
}

test("exact-head verifier accepts complete native, packaged, soak, upgrade, and explicit certification states", () => {
	const manifest = validManifest();
	assert.equal(manifest.platforms.length, 3);
	assert.equal(manifest.certifications.every((claim) => claim.productReady === false), true);
	assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/u);
});

test("exact-head verifier rejects stale SHA and mixed-head records", () => {
	rejectMutation((manifest) => {
		manifest.platforms[0].job.headSha = OTHER_HEAD_SHA;
	}, /stale/u);
	rejectMutation((manifest) => {
		manifest.platforms[1].packageSmoke.runtimes[0].headSha = OTHER_HEAD_SHA;
	}, /stale/u);
});

test("exact-head verifier rejects missing native OS or packaged runtime", () => {
	rejectMutation((manifest) => {
		manifest.platforms.pop();
	}, /three native platforms/u);
	rejectMutation((manifest) => {
		manifest.platforms[0].packageSmoke.runtimes = manifest.platforms[0].packageSmoke.runtimes.filter(
			(record) => record.runtime !== "compiled",
		);
	}, /missing compiled packaged smoke/u);
});

test("exact-head verifier rejects cancelled jobs and nonzero known gaps", () => {
	rejectMutation((manifest) => {
		manifest.platforms[0].job.state = "cancelled";
	}, /cancelled|did not pass/u);
	rejectMutation((manifest) => {
		manifest.platforms[0].upgrade.state = "partial";
	}, /partial/u);
	rejectMutation((manifest) => {
		manifest.knownGaps.count = 1;
		manifest.knownGaps.state = "failed";
	}, /zero final known gaps/u);
});

test("exact-head verifier rejects fake evidence substituted for real certification", () => {
	rejectMutation((manifest) => {
		manifest.certifications[0].record = createStructuralCertificationRecord({
			connector: manifest.certifications[0].connector,
			headSha: HEAD_SHA,
			platform: "linux",
		});
	}, /fake/u);
});

test("exact-head verifier rejects structural soak and offline upgrade promotion", () => {
	rejectMutation((manifest) => {
		manifest.platforms[0].soak.evidenceClass = "structural_fixture";
	}, /not a packaged standard product trace/u);
	rejectMutation((manifest) => {
		manifest.platforms[0].upgrade.evidenceClass = "offline_fixture";
	}, /not packaged previous-release evidence/u);
});

test("exact-head verifier accepts a product-ready claim only for an authorized passing record", () => {
	const manifest = structuredClone(validManifest());
	delete manifest.digest;
	const claim = manifest.certifications[0];
	claim.productReady = true;
	claim.record = validateCertificationRecord({
		schemaVersion: 1,
		type: "connector_certification",
		connector: claim.connector,
		headSha: HEAD_SHA,
		evidenceClass: "product_certification",
		state: "passed",
		reasonCode: "authorized_certification_passed",
		platform: "linux",
		dependency: { name: "certified-connector", version: "1.2.3", digest: `sha256:${"7".repeat(64)}` },
		authority: { kind: "explicit_isolated", referenceDigest: `sha256:${"8".repeat(64)}` },
		checks: { handshake: "passed", start: "passed", cancel: "passed", resume: "passed", tool: "passed" },
		safety: { credentialsPersisted: false, promptsPersisted: false, pathsPersisted: false, transcriptsPersisted: false },
		source: "authorized_external_run",
	});
	assert.equal(
		validateLine13EvidenceManifest(manifest, HEAD_SHA, BASE_SHA, WORKFLOW_PATH, [MIDDLE_SHA, HEAD_SHA]).certifications[0].productReady,
		true,
	);
	claim.productReady = false;
	assert.throws(
		() => validateLine13EvidenceManifest(manifest, HEAD_SHA, BASE_SHA, WORKFLOW_PATH, [MIDDLE_SHA, HEAD_SHA]),
		/product-ready claim/u,
	);
});

test("exact milestone evidence rejects chain gaps, parent mismatch, cancelled gates, stale ACs, and missing Qs", () => {
	rejectMutation((manifest) => {
		manifest.milestoneChain.commits.splice(0, 1);
	}, /base-to-head gap|sequence gap|parent continuity/u);
	rejectMutation((manifest) => {
		manifest.milestoneChain.commits[1].parentSha = BASE_SHA;
	}, /parent continuity/u);
	rejectMutation((manifest) => {
		manifest.milestoneChain.commits[0].gate.cancelled = true;
	}, /cancelled/u);
	rejectMutation((manifest) => {
		manifest.acOwnerTransitions.transitions[0].headSha = OTHER_HEAD_SHA;
	}, /stale/u);
	rejectMutation((manifest) => {
		manifest.qualityGates.gates.pop();
	}, /Q0 through Q18/u);
});

test("exact milestone evidence rejects duplicate and input-digest drift", () => {
	rejectMutation((manifest) => {
		manifest.qualityGates.gates[1].id = manifest.qualityGates.gates[0].id;
	}, /duplicate/u);
	rejectMutation((manifest) => {
		manifest.qualityGates.gates[0].command.id = "drifted.command";
	}, /inputDigest drifted/u);
});

test("CI provenance is built from matching successful GitHub API metadata", () => {
	const provenance = ciProvenance();
	assert.equal(provenance.source, "github_actions_api");
	assert.equal(provenance.workflow.path, WORKFLOW_PATH);
	assert.equal(provenance.run.id, RUN_ID);
	assert.equal(provenance.run.cancelled, false);
	assert.equal(provenance.artifact.id, ARTIFACT_ID);
	assert.equal(provenance.artifact.digest, ARTIFACT_DIGEST);
});

test("CI provenance creation rejects stale, failed, cancelled, cross-run, workflow, and artifact metadata", () => {
	assert.throws(() => ciProvenance({ run: { head_sha: OTHER_HEAD_SHA } }), /stale head/u);
	assert.throws(() => ciProvenance({ run: { conclusion: "failure" } }), /failed, cancelled, or incomplete/u);
	assert.throws(() => ciProvenance({ run: { conclusion: "cancelled" } }), /failed, cancelled, or incomplete/u);
	assert.throws(() => ciProvenance({ workflow: { path: ".github/workflows/other.yml" } }), /expected workflow/u);
	assert.throws(() => ciProvenance({ artifact: { id: ARTIFACT_ID + 1 } }), /requested artifact/u);
	assert.throws(() => ciProvenance({ artifact: { workflow_run: { id: RUN_ID + 1, head_sha: HEAD_SHA } } }), /different workflow run/u);
});

test("exact-head verifier rejects missing or synthetic CI provenance", () => {
	rejectMutation((manifest) => {
		delete manifest.ciProvenance;
	}, /ciProvenance/u);
	rejectMutation((manifest) => {
		manifest.milestoneChain.commits[0].gate.ciArtifact = identity("synthetic.artifact", "2");
	}, /ciArtifact/u);
});

test("exact-head verifier binds provenance to workflow, head, base, successful run, and artifact", () => {
	const manifest = structuredClone(validManifest());
	delete manifest.digest;
	assert.throws(
		() => validateLine13EvidenceManifest(
			manifest,
			HEAD_SHA,
			BASE_SHA,
			".github/workflows/other.yml",
			[MIDDLE_SHA, HEAD_SHA],
		),
		/wrong workflow/u,
	);
	rejectMutation((candidate) => {
		candidate.ciProvenance.headSha = OTHER_HEAD_SHA;
	}, /stale head/u);
	rejectMutation((candidate) => {
		candidate.ciProvenance.baseSha = OTHER_HEAD_SHA;
	}, /stale base/u);
	rejectMutation((candidate) => {
		candidate.ciProvenance.run.conclusion = "failure";
	}, /failed, cancelled, or incomplete/u);
	rejectMutation((candidate) => {
		candidate.ciProvenance.run.cancelled = true;
	}, /failed, cancelled, or incomplete/u);
	rejectMutation((candidate) => {
		candidate.qualityGates.gates[0].ciArtifact.runId = RUN_ID + 1;
	}, /different workflow run/u);
	rejectMutation((candidate) => {
		candidate.milestoneChain.commits[0].gate.ciArtifact.artifactId = ARTIFACT_ID + 1;
	}, /different artifact/u);
	rejectMutation((candidate) => {
		candidate.milestoneChain.commits[0].gate.ciArtifact.digest = `sha256:${"8".repeat(64)}`;
	}, /attested artifact/u);
});
