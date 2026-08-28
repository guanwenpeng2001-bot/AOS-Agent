import assert from "node:assert/strict";
import test from "node:test";
import {
	LINE13_SOAK_RESOURCE_NAMES,
	runLine13Soak,
} from "../scripts/line13-soak.mjs";

const HEAD_SHA = "a".repeat(40);

test("Line 13 soak is deterministic and reaches a zero-resource plateau", () => {
	const options = { headSha: HEAD_SHA, platform: "linux", iterations: 70, plateauWindow: 14 };
	const first = runLine13Soak(options);
	const second = runLine13Soak(options);

	assert.deepEqual(first, second);
	assert.equal(first.state, "passed");
	assert.equal(first.provider.pendingResponses, 0);
	assert.equal(first.clock.pendingTimers, 0);
	assert.equal(first.resources.plateauSamples, 14);
	for (const name of LINE13_SOAK_RESOURCE_NAMES) {
		assert.equal(first.resources.final[name], 0, name);
	}
	assert.ok(first.resources.peaks.processes > 0);
	assert.ok(first.resources.peaks.pendingWrites > 0);
	assert.ok(first.resources.peaks.credentials > 0);
});

test("Line 13 soak exercises every injected cleanup fault without residual resources", () => {
	const result = runLine13Soak({ headSha: HEAD_SHA, platform: "windows", iterations: 35, plateauWindow: 7 });
	assert.deepEqual(Object.keys(result.faults.counts), result.faults.plan);
	for (const count of Object.values(result.faults.counts)) assert.equal(count, 5);
	assert.deepEqual(Object.values(result.resources.final), Array(LINE13_SOAK_RESOURCE_NAMES.length).fill(0));
});

test("Line 13 soak fails closed when a pending write leaks", () => {
	assert.throws(
		() =>
			runLine13Soak({
				headSha: HEAD_SHA,
				platform: "macos",
				iterations: 8,
				plateauWindow: 4,
				faultPlan: ["none", "leak_pending_write"],
			}),
		/retained pendingWrites=/u,
	);
});
