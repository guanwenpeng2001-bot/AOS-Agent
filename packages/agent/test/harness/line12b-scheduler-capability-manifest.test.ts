import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	foundationClosureById,
	FOUNDATION_V1_CAPABILITY_CLOSURES,
} from "../../src/harness/foundation-v1-capabilities.ts";
import {
	LINE12B_SCHEDULER_CAPABILITY_CLOSURES,
	LINE12B_SCHEDULER_DEFERRED_CAPABILITIES,
} from "../../src/harness/line12b-scheduler-capabilities.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const IMPLEMENTED = [119, 120, 121, 122, 123, 124, 125, 126, 130, 131];
const CONSUMED = [3, 5, 6, 10, 16, 26, 47, 51, 53, 55, 56, 57, 58, 61, 98, 127, 128, 129];
const CLOSED_12A = [90, 91, 92, 93, 94, 95, 96, 97, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118];
const DEFERRED = [
	...CLOSED_12A.map((id) => ({ id, deferredTo: "12A" })),
	...[132, 133, 138].map((id) => ({ id, deferredTo: "13" })),
	...[134, 137, 139, 141, 142, 143, 144, 149, 150].map((id) => ({ id, deferredTo: "14" })),
	...[147, 148].map((id) => ({ id, deferredTo: "15" })),
];

describe("Line 12B Scheduler capability manifest", () => {
	it("closes the exact implemented and consumed sets", () => {
		expect(LINE12B_SCHEDULER_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "implemented").map((entry) => entry.id)).toEqual(IMPLEMENTED);
		expect(LINE12B_SCHEDULER_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "consumed_foundation").map((entry) => entry.id)).toEqual(CONSUMED);
	});

	it("references every consumed capability from the sealed Foundation 79-item set", () => {
		expect(FOUNDATION_V1_CAPABILITY_CLOSURES).toHaveLength(79);
		for (const entry of LINE12B_SCHEDULER_CAPABILITY_CLOSURES.filter((candidate) => candidate.closure === "consumed_foundation")) {
			expect(entry.foundationClosure).toBe(foundationClosureById(entry.id));
		}
	});

	it("uses the exact deferred owner map", () => {
		expect(LINE12B_SCHEDULER_DEFERRED_CAPABILITIES).toMatchObject(DEFERRED);
		expect(LINE12B_SCHEDULER_DEFERRED_CAPABILITIES).toHaveLength(DEFERRED.length);
	});

	it("keeps implemented, consumed, and deferred pairwise disjoint and does not reopen Foundation or 12A", () => {
		const foundation = new Set(FOUNDATION_V1_CAPABILITY_CLOSURES.map((entry) => entry.id));
		const implemented = new Set(IMPLEMENTED);
		const consumed = new Set(CONSUMED);
		const deferred = new Set(DEFERRED.map((entry) => entry.id));
		for (const id of implemented) {
			expect(consumed.has(id)).toBe(false);
			expect(deferred.has(id)).toBe(false);
			expect(foundation.has(id)).toBe(false);
			expect(CLOSED_12A).not.toContain(id);
		}
		for (const id of consumed) {
			expect(deferred.has(id)).toBe(false);
			expect(foundation.has(id)).toBe(true);
			expect(CLOSED_12A).not.toContain(id);
		}
	});

	it("uses existing owner and test evidence paths for every implemented item", () => {
		for (const entry of LINE12B_SCHEDULER_CAPABILITY_CLOSURES.filter((candidate) => candidate.closure === "implemented")) {
			expect(entry.ownerModule.trim()).not.toBe("");
			expect(existsSync(resolve(REPOSITORY_ROOT, entry.ownerModule))).toBe(true);
			expect(entry.tests.length).toBeGreaterThan(0);
			for (const test of entry.tests) expect(existsSync(resolve(REPOSITORY_ROOT, test))).toBe(true);
		}
	});
});
