import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	previousSpecFromResolution,
	runLine13UpgradeHarness,
	selectPreviousPublishedVersion,
} from "../scripts/line13-upgrade.mjs";

const HEAD_SHA = "c".repeat(40);

function fixtureOwnerState() {
	return {
		session: { id: "line13-upgrade", entries: 2 },
		settings: { defaultProvider: "faux", steeringMode: "one-at-a-time" },
		trust: { decision: true },
		auth: { providers: [{ providerId: "line13.faux-provider", type: "api_key" }] },
		identity: { installationIdDigest: `sha256:${"1".repeat(64)}` },
		connectorConfig: {
			schemaVersion: 1,
			targetCount: 1,
			selectedTargetId: "line13-upgrade-target",
			providerId: "line13.fake-connector",
			source: "managed",
			configRevision: `sha256:${"2".repeat(64)}`,
			selectionRevision: `sha256:${"3".repeat(64)}`,
			capabilityCeiling: {
				modelAccess: ["none"],
				resume: false,
				toolGateway: false,
				artifacts: false,
				images: false,
			},
			selectionSources: ["explicit"],
		},
	};
}

function fakePackageExecutor() {
	const calls = [];
	return {
		calls,
		install({ spec, installDirectory }) {
			calls.push({ operation: "install", spec, installDirectory });
			mkdirSync(installDirectory, { recursive: true });
			return {
				name: "aos-agent",
				version: spec.includes("candidate") ? "0.84.3" : "0.84.2",
				digest: `sha256:${(spec.includes("candidate") ? "4" : "3").repeat(64)}`,
			};
		},
		generatePrevious({ stateDirectory }) {
			calls.push({ operation: "generate_previous" });
			mkdirSync(stateDirectory, { recursive: true });
			const state = {
				schemaVersion: 1,
				packageVersion: "0.84.2",
				sessionFile: "sessions/line13-upgrade.jsonl",
				cwd: "workspace",
				agentDir: "agent",
				owners: fixtureOwnerState(),
			};
			writeFileSync(join(stateDirectory, "publication.json"), `${JSON.stringify(state)}\n`, "utf8");
			return state;
		},
		migrateCandidate({ stateDirectory, fault }) {
			calls.push({ operation: "migrate_candidate", fault });
			if (fault === "before_publish") return { status: 2, ok: false, error: "injected_before_publish" };
			const state = {
				schemaVersion: 2,
				packageVersion: "0.84.2",
				owners: fixtureOwnerState(),
				migration: { fromSchemaVersion: 1, complete: true },
			};
			writeFileSync(join(stateDirectory, "publication.json"), `${JSON.stringify(state)}\n`, "utf8");
			if (fault === "after_publish") return { status: 2, ok: false, error: "injected_after_publish" };
			return {
				status: 0,
				ok: true,
				result: {
					entrypoint: "aos-agent/external-connector",
					adapter: "packaged_durable_state_migration",
					owners: ["session", "settings", "trust", "auth", "identity", "connector_config"],
					stateDigest: `sha256:${"5".repeat(64)}`,
				},
			};
		},
	};
}

test("offline upgrade fixtures invoke both package adapters but cannot mint packaged evidence", () => {
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
			workRoot,
			repoRoot,
		}, executor);
		assert.equal(evidence.state, "passed");
		assert.equal(evidence.evidenceClass, "offline_fixture");
		assert.deepEqual(evidence.entrypoints, { previous: "aos-agent", candidate: "aos-agent/external-connector" });
		assert.deepEqual(evidence.scenarios.map((scenario) => scenario.recoveredSchemaVersion), [1, 2]);
		assert.equal(executor.calls.filter((call) => call.operation === "generate_previous").length, 2);
		assert.equal(executor.calls.filter((call) => call.operation === "migrate_candidate").length, 6);
		assert.equal(existsSync(workRoot), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("upgrade harness rejects repository-local work roots", () => {
	assert.throws(
		() => runLine13UpgradeHarness({
			headSha: HEAD_SHA,
			platform: "windows",
			previousSpec: "fixture-previous",
			candidateSpec: "fixture-candidate",
			workRoot: join(process.cwd(), "line13-local-work"),
		}, fakePackageExecutor()),
		/outside the repository/u,
	);
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
