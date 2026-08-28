import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	LINE13_SOAK_OPERATION_PLAN,
	LINE13_SOAK_RESOURCE_NAMES,
	runLine13Soak,
	runLine13StructuralSoak,
} from "../scripts/line13-soak.mjs";

const HEAD_SHA = "a".repeat(40);

function productTrace(iterations) {
	const final = Object.fromEntries(LINE13_SOAK_RESOURCE_NAMES.map((name) => [name, name === "files" ? 1 : 0]));
	return {
		schemaVersion: 1,
		entrypoint: "aos-agent/external-connector",
		adapter: "standard_product_composition",
		iterations,
		operations: Object.fromEntries(LINE13_SOAK_OPERATION_PLAN.map((operation) => [operation, 1])),
		canonicalOwners: [
			"agent_harness",
			"external_connector_registry",
			"task_credential_service",
			"scheduler_selection_reservations",
			"worker_registry",
			"scheduler_status",
			"session_manager",
		],
		samples: Array.from({ length: iterations }, () => ({ ...final })),
		final,
		provider: { kind: "faux", pendingResponses: 0 },
	};
}

test("script-local structural soak is explicitly ineligible for final evidence", () => {
	const result = runLine13StructuralSoak({ headSha: HEAD_SHA, platform: "linux", iterations: 28, plateauWindow: 7 });
	assert.equal(result.state, "passed");
	assert.equal(result.evidenceClass, "structural_fixture");
	assert.deepEqual(result.canonicalOwners, []);
	assert.equal(result.clock.pendingTimers, 0);
	assert.equal(Object.values(result.faults.counts).reduce((total, count) => total + count, 0), 28);
	assert.deepEqual(Object.values(result.resources.final), Array(LINE13_SOAK_RESOURCE_NAMES.length).fill(0));
});

test("offline adapters are invoked but cannot mint product-trace evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-soak-test-"));
	const repoRoot = join(root, "repo");
	const workRoot = join(root, "outside", "run");
	mkdirSync(repoRoot);
	let calls = 0;
	try {
		const result = await runLine13Soak({
			headSha: HEAD_SHA,
			platform: "linux",
			candidateSpec: "fixture-candidate",
			workRoot,
			repoRoot,
			iterations: 7,
			plateauWindow: 2,
		}, {
			run({ iterations }) {
				calls += 1;
				return productTrace(iterations);
			},
		});
		assert.equal(calls, 1);
		assert.equal(result.evidenceClass, "structural_fixture");
		assert.equal(result.operations.restart, 1);
		assert.equal(result.resources.final.files, 1);
		assert.equal(existsSync(workRoot), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("product trace validation fails closed when a canonical owner retains work", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-soak-leak-test-"));
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	try {
		await assert.rejects(
			runLine13Soak({
				headSha: HEAD_SHA,
				platform: "macos",
				candidateSpec: "fixture-candidate",
				workRoot: join(root, "outside", "run"),
				repoRoot,
				iterations: 7,
				plateauWindow: 2,
			}, {
				run({ iterations }) {
					const trace = productTrace(iterations);
					trace.final.pendingWrites = 1;
					return trace;
				},
			}),
			/retained pendingWrites/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
