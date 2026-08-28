import assert from "node:assert/strict";
import test from "node:test";
import {
	createAbsentProductCertificationRecord,
	createStructuralCertificationRecord,
	validateCertificationRecord,
} from "../scripts/line13-certification.mjs";

const HEAD_SHA = "b".repeat(40);

test("certification schema separates passing fake structure from real product certification", () => {
	const structural = createStructuralCertificationRecord({
		connector: "acp",
		headSha: HEAD_SHA,
		platform: "linux",
	});
	assert.equal(structural.state, "passed");
	assert.equal(structural.evidenceClass, "structural_fake");
	assert.equal(structural.authority.kind, "none");

	const masquerading = { ...structural, evidenceClass: "product_certification" };
	delete masquerading.digest;
	assert.throws(() => validateCertificationRecord(masquerading), /authorized external run/u);
});

test("absent real connector evidence stays explicit and cannot become passed", () => {
	const unavailable = createAbsentProductCertificationRecord({
		connector: "codex_app_server",
		headSha: HEAD_SHA,
		state: "unavailable",
		reasonCode: "authorized_environment_unavailable",
	});
	assert.equal(unavailable.evidenceClass, "product_certification");
	assert.equal(unavailable.state, "unavailable");
	assert.equal(unavailable.dependency, null);
	assert.throws(
		() =>
			createAbsentProductCertificationRecord({
				connector: "codex_app_server",
				headSha: HEAD_SHA,
				state: "passed",
				reasonCode: "invented_pass",
			}),
		/can create only absent/u,
	);
});

test("passed real certification requires pinned identity, native platform, and authorized checks", () => {
	const valid = validateCertificationRecord({
		schemaVersion: 1,
		type: "connector_certification",
		connector: "claude_agent_sdk",
		headSha: HEAD_SHA,
		evidenceClass: "product_certification",
		state: "passed",
		reasonCode: "authorized_certification_passed",
		platform: "macos",
		dependency: {
			name: "@anthropic-ai/claude-agent-sdk",
			version: "0.3.246",
			digest: `sha256:${"1".repeat(64)}`,
		},
		authority: { kind: "explicit_isolated", referenceDigest: `sha256:${"2".repeat(64)}` },
		checks: { handshake: "passed", start: "passed", cancel: "passed", resume: "passed", tool: "passed" },
		safety: { credentialsPersisted: false, promptsPersisted: false, pathsPersisted: false, transcriptsPersisted: false },
		source: "authorized_external_run",
	});
	assert.equal(valid.state, "passed");

	const missingIdentity = { ...valid, dependency: null };
	delete missingIdentity.digest;
	assert.throws(() => validateCertificationRecord(missingIdentity), /requires authorization, platform, and dependency/u);
});

test("failed real certification remains executed external evidence, not an absence record", () => {
	const failed = validateCertificationRecord({
		schemaVersion: 1,
		type: "connector_certification",
		connector: "acp",
		headSha: HEAD_SHA,
		evidenceClass: "product_certification",
		state: "failed",
		reasonCode: "authorized_check_failed",
		platform: "windows",
		dependency: { name: "@agentclientprotocol/sdk", version: "0.14.1", digest: `sha256:${"3".repeat(64)}` },
		authority: { kind: "explicit_isolated", referenceDigest: `sha256:${"4".repeat(64)}` },
		checks: { handshake: "passed", start: "passed", cancel: "failed", resume: "not_run", tool: "not_run" },
		safety: { credentialsPersisted: false, promptsPersisted: false, pathsPersisted: false, transcriptsPersisted: false },
		source: "authorized_external_run",
	});
	assert.equal(failed.state, "failed");
	assert.throws(
		() => createAbsentProductCertificationRecord({ connector: "acp", headSha: HEAD_SHA, state: "failed", reasonCode: "failed" }),
		/can create only absent/u,
	);
});
