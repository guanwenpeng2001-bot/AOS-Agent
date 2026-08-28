import assert from "node:assert/strict";
import test from "node:test";
import {
	LINE13_CONNECTORS,
	LINE13_PLATFORMS,
	LINE13_REQUIRED_CHECKS,
	LINE13_RUNTIME_KINDS,
	digestJson,
} from "../packages/coding-agent/scripts/line13-evidence-common.mjs";
import {
	createAbsentProductCertificationRecord,
	createStructuralCertificationRecord,
	validateCertificationRecord,
} from "../packages/coding-agent/scripts/line13-certification.mjs";
import { runLine13Soak } from "../packages/coding-agent/scripts/line13-soak.mjs";
import {
	assembleLine13EvidenceManifest,
	createNativeJobRecord,
	validateLine13EvidenceManifest,
} from "./verify-line13-evidence.mjs";

const HEAD_SHA = "a".repeat(40);
const OTHER_HEAD_SHA = "b".repeat(40);

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
		schemaVersion: 1,
		type: "upgrade",
		headSha: HEAD_SHA,
		platform,
		state: "passed",
		evidenceClass: "packaged_execution",
		previousPackage: { name: "aos-agent", version: "0.84.2", digest: `sha256:${"4".repeat(64)}` },
		candidatePackage: { name: "aos-agent", version: "0.84.3", digest: `sha256:${"5".repeat(64)}` },
		outsideRepository: true,
		scenarios: [
			{ fault: "before_publish", recoveredSchemaVersion: 1, finalSchemaVersion: 2 },
			{ fault: "after_publish", recoveredSchemaVersion: 2, finalSchemaVersion: 2 },
		],
		restartValidated: true,
		idempotentMigration: true,
		secretsPersisted: false,
		cleanup: { processes: 0, files: 0, pendingWrites: 0, credentials: 0 },
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
	}];
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
		records.push(runLine13Soak({ headSha: HEAD_SHA, platform, iterations: 28, plateauWindow: 7 }));
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
	return assembleLine13EvidenceManifest(records, HEAD_SHA);
}

function rejectMutation(mutate, pattern) {
	const manifest = structuredClone(validManifest());
	delete manifest.digest;
	mutate(manifest);
	assert.throws(() => validateLine13EvidenceManifest(manifest, HEAD_SHA), pattern);
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
	assert.equal(validateLine13EvidenceManifest(manifest, HEAD_SHA).certifications[0].productReady, true);
	claim.productReady = false;
	assert.throws(() => validateLine13EvidenceManifest(manifest, HEAD_SHA), /product-ready claim/u);
});
