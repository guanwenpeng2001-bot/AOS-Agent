import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	previousSpecFromResolution,
	runLine13UpgradeHarness,
	selectPreviousPublishedVersion,
} from "../scripts/line13-upgrade.mjs";

const HEAD_SHA = "c".repeat(40);
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/line13-upgrade/previous-state.json", import.meta.url), "utf8"));

function fakePackageExecutor() {
	const calls = [];
	return {
		calls,
		installAndRun({ spec, installDirectory }) {
			calls.push({ spec, installDirectory });
			mkdirSync(installDirectory, { recursive: true });
			writeFileSync(join(installDirectory, "ran"), `${spec}\n`, "utf8");
			const version = spec.includes("candidate") ? "0.84.3" : "0.84.2";
			return { name: "aos-agent", version, digest: `sha256:${(spec.includes("candidate") ? "4" : "3").repeat(64)}` };
		},
	};
}

test("offline upgrade fixtures install and run outside the repository without network", () => {
	const root = mkdtempSync(join(tmpdir(), "line13-upgrade-test-"));
	const repoRoot = join(root, "repo");
	const workRoot = join(root, "outside", "run");
	mkdirSync(repoRoot);
	const executor = fakePackageExecutor();
	try {
		const evidence = runLine13UpgradeHarness({
			headSha: HEAD_SHA,
			platform: "linux",
			previousSpec: "fixture-previous",
			candidateSpec: "fixture-candidate",
			previousState: FIXTURE,
			workRoot,
			repoRoot,
			packageExecutor: executor,
			executionKind: "offline_fixture",
		});
		assert.equal(evidence.state, "passed");
		assert.equal(evidence.evidenceClass, "offline_fixture");
		assert.equal(evidence.outsideRepository, true);
		assert.equal(evidence.restartValidated, true);
		assert.equal(evidence.idempotentMigration, true);
		assert.equal(evidence.secretsPersisted, false);
		assert.deepEqual(evidence.scenarios.map((scenario) => scenario.recoveredSchemaVersion), [1, 2]);
		assert.equal(executor.calls.length, 2);
		assert.equal(executor.calls.every((call) => call.installDirectory.startsWith(workRoot)), true);
		assert.equal(readFileSync(new URL("./fixtures/line13-upgrade/previous-state.json", import.meta.url), "utf8").includes("secret"), false);
		assert.equal(existsSync(workRoot), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("upgrade harness rejects repository-local work roots and credential-like fixture material", () => {
	assert.throws(
		() =>
			runLine13UpgradeHarness({
				headSha: HEAD_SHA,
				platform: "windows",
				previousSpec: "fixture-previous",
				candidateSpec: "fixture-candidate",
				previousState: FIXTURE,
				workRoot: join(process.cwd(), "line13-local-work"),
				packageExecutor: fakePackageExecutor(),
			}),
		/outside the repository/u,
	);

	const root = mkdtempSync(join(tmpdir(), "line13-upgrade-secret-test-"));
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	try {
		assert.throws(
			() =>
				runLine13UpgradeHarness({
					headSha: HEAD_SHA,
					platform: "macos",
					previousSpec: "fixture-previous",
					candidateSpec: "fixture-candidate",
					previousState: { ...FIXTURE, auth: { accessToken: "credential-value" } },
					workRoot: join(root, "outside", "run"),
					repoRoot,
					packageExecutor: fakePackageExecutor(),
				}),
			/forbidden secret field/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("previous release selection is stable and ignores prereleases", () => {
	assert.equal(selectPreviousPublishedVersion("0.84.3", ["0.84.2", "0.84.3-beta.1", "0.83.9", "0.84.3"]), "0.84.2");
	assert.throws(() => selectPreviousPublishedVersion("0.1.0", ["0.1.0-beta.1"]), /No previous stable/u);
	assert.equal(
		previousSpecFromResolution({
			schemaVersion: 1,
			type: "previous_version",
			package: "aos-agent",
			currentVersion: "0.84.3",
			previousVersion: "0.84.2",
			state: "resolved",
		}),
		"aos-agent@0.84.2",
	);
	assert.throws(
		() => previousSpecFromResolution({
			schemaVersion: 1,
			type: "previous_version",
			package: "aos-agent",
			currentVersion: "0.84.3",
			previousVersion: "0.84.3",
			state: "resolved",
		}),
		/older than/u,
	);
});
