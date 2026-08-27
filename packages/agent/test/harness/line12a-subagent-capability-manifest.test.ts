import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	FOUNDATION_CAPABILITY_CLOSURES,
	FOUNDATION_FUTURE_CAPABILITY_OWNERS,
	foundationClosureById,
	foundationFutureOwnerById,
} from "../../src/harness/foundation-capabilities.ts";
import { LINE11_WORKER_CAPABILITY_CLOSURES } from "../../src/harness/line11-worker-capabilities.ts";
import {
	LINE12A_SUBAGENT_CAPABILITY_CLOSURES,
	LINE12A_SUBAGENT_DEFERRED_CAPABILITIES,
} from "../../src/harness/line12a-subagent-capabilities.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const IMPLEMENTED_IDS = [
	90, 91, 92, 93, 94, 95, 96, 97, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
	116, 117, 118,
];
const CONSUMED_FOUNDATION_IDS = [2, 6, 8, 9, 17, 18, 19, 20, 26, 29, 30, 31, 32, 33, 34, 98];
const DEFERRED = [
	...[119, 120, 121, 122, 123, 124, 125, 126, 130, 131].map((id) => ({ id, deferredTo: "12B" })),
	...[132, 133, 138].map((id) => ({ id, deferredTo: "13" })),
	...[134, 137, 139, 141, 142, 143, 144, 149, 150].map((id) => ({ id, deferredTo: "14" })),
	...[147, 148].map((id) => ({ id, deferredTo: "15" })),
];

describe("Line 12A Native Subagent capability manifest", () => {
	it("closes exactly capabilities 90-97 and 99-118", () => {
		const ids = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "implemented")
			.map((entry) => entry.id)
			.sort((a, b) => a - b);
		expect(ids).toEqual(IMPLEMENTED_IDS);
		expect(ids).toHaveLength(28);
	});

	it("consumes exactly 16 sealed Foundation closures by direct reference", () => {
		const consumed = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.filter(
			(entry) => entry.closure === "consumed_foundation",
		).sort((a, b) => a.id - b.id);
		expect(consumed.map((entry) => entry.id)).toEqual(CONSUMED_FOUNDATION_IDS);
		expect(consumed).toHaveLength(16);
		for (const entry of consumed) {
			expect(entry.foundationClosure).toBe(foundationClosureById(entry.id));
			expect(entry.publicContract).toBeUndefined();
		}
	});

	it("preserves the exact later owners and excludes capability 140", () => {
		expect(LINE12A_SUBAGENT_DEFERRED_CAPABILITIES).toMatchObject(DEFERRED);
		expect(LINE12A_SUBAGENT_DEFERRED_CAPABILITIES).toHaveLength(24);
		for (const entry of LINE12A_SUBAGENT_DEFERRED_CAPABILITIES) {
			expect(entry.deferredTo).toBe(foundationFutureOwnerById(entry.id)?.laterOwner);
			expect(entry.reason.trim()).not.toBe("");
		}
		expect(LINE12A_SUBAGENT_DEFERRED_CAPABILITIES.map((entry) => entry.id)).not.toContain(140);
		expect(foundationFutureOwnerById(140)?.laterOwner).toBe("11");
	});

	it("keeps implemented, consumed, and deferred ids unique and pairwise disjoint", () => {
		const implemented = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "implemented").map(
			(entry) => entry.id,
		);
		const consumed = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.filter(
			(entry) => entry.closure === "consumed_foundation",
		).map((entry) => entry.id);
		const deferred = LINE12A_SUBAGENT_DEFERRED_CAPABILITIES.map((entry) => entry.id);
		for (const ids of [implemented, consumed, deferred]) expect(new Set(ids).size).toBe(ids.length);
		expect(implemented.some((id) => consumed.includes(id) || deferred.includes(id))).toBe(false);
		expect(consumed.some((id) => deferred.includes(id))).toBe(false);
	});

	it("does not overlap sealed Foundation or Line 11 closures", () => {
		const implemented = new Set(
			LINE12A_SUBAGENT_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "implemented").map(
				(entry) => entry.id,
			),
		);
		expect(FOUNDATION_CAPABILITY_CLOSURES.some((entry) => implemented.has(entry.id))).toBe(false);
		expect(LINE11_WORKER_CAPABILITY_CLOSURES.some((entry) => implemented.has(entry.id))).toBe(false);
	});

	it("uses concrete existing owner modules and test evidence for every closure", () => {
		for (const entry of LINE12A_SUBAGENT_CAPABILITY_CLOSURES) {
			expect(entry.ownerModule.trim()).not.toBe("");
			expect(existsSync(resolve(REPOSITORY_ROOT, entry.ownerModule)), `missing owner for ${entry.id}`).toBe(true);
			expect(entry.tests.length).toBeGreaterThan(0);
			for (const test of entry.tests) {
				expect(test.trim()).not.toBe("");
				expect(existsSync(resolve(REPOSITORY_ROOT, test)), `missing test evidence for ${entry.id}: ${test}`).toBe(
					true,
				);
			}
			if (entry.closure === "implemented") expect(entry.publicContract?.trim()).not.toBe("");
		}
	});

	it("keeps the sealed Foundation ledgers unchanged", () => {
		expect(FOUNDATION_CAPABILITY_CLOSURES).toHaveLength(79);
		expect(FOUNDATION_FUTURE_CAPABILITY_OWNERS).toHaveLength(71);
		expect(
			FOUNDATION_FUTURE_CAPABILITY_OWNERS.filter((entry) => entry.laterOwner === "12A").map((entry) => entry.id),
		).toEqual(IMPLEMENTED_IDS);
	});

	it("separates capability 111 registry taxonomy from provider availability", () => {
		const capability = foundationFutureOwnerById(111);
		expect(capability?.description).toContain("native subagent providers");
		expect(capability?.description).not.toMatch(/\b(?:ACP|Codex|Claude|SDK)\b/);
		const closure = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.find((entry) => entry.id === 111);
		expect(closure?.publicContract).toContain("three-kind Native Agent provider registry");
		expect(closure?.publicContract).toContain("in-process and fork available");
		expect(closure?.publicContract).toContain("Agent Runtime Host unavailable");
		expect(closure?.publicContract).not.toContain("connector.");
	});
});
