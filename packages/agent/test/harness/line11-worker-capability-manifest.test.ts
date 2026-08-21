import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	foundationClosureById,
	foundationFutureOwnerById,
	FOUNDATION_V1_CAPABILITY_CLOSURES,
	FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS,
} from "../../src/harness/foundation-v1-capabilities.ts";
import {
	LINE11_WORKER_CAPABILITY_CLOSURES,
	LINE11_WORKER_DEFERRED_CAPABILITIES,
	LINE11_WORKER_REVIEW_LEDGER,
} from "../../src/harness/line11-worker-capabilities.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const IMPLEMENTED_IDS = [...range(74, 87), 135, 136];
const CONSUMED_FOUNDATION_IDS = [6, 32, 47, 52, 61];
const DEFERRED = [
	{ id: 88, deferredTo: "14" },
	{ id: 89, deferredTo: "14" },
	{ id: 132, deferredTo: "13" },
	{ id: 137, deferredTo: "14" },
];

function range(start: number, end: number): number[] {
	const ids: number[] = [];
	for (let id = start; id <= end; id++) ids.push(id);
	return ids;
}

describe("Line 11 Worker capability manifest", () => {
	it("closes exactly capabilities 74-87, 135 and 136 as implemented", () => {
		const ids = LINE11_WORKER_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "implemented")
			.map((entry) => entry.id)
			.sort((a, b) => a - b);
		expect(ids).toEqual(IMPLEMENTED_IDS);
		expect(ids).toHaveLength(16);
	});

	it("consumes exactly five sealed Foundation closures by direct reference", () => {
		const consumed = LINE11_WORKER_CAPABILITY_CLOSURES.filter((entry) => entry.closure === "consumed_foundation").sort(
			(a, b) => a.id - b.id,
		);
		expect(consumed.map((entry) => entry.id)).toEqual(CONSUMED_FOUNDATION_IDS);
		for (const entry of consumed) {
			expect(entry.foundationClosure).toBe(foundationClosureById(entry.id));
			expect(entry.foundationClosure?.publicContract?.trim()).not.toBe("");
		}
	});

	it("defers only 88/89 to line 14, 132 to line 13 and 137 to line 14", () => {
		expect(LINE11_WORKER_DEFERRED_CAPABILITIES).toMatchObject(DEFERRED);
		expect(LINE11_WORKER_DEFERRED_CAPABILITIES).toHaveLength(4);
		for (const entry of LINE11_WORKER_DEFERRED_CAPABILITIES) {
			expect(entry.deferredTo).toBe(foundationFutureOwnerById(entry.id)?.laterOwner);
			expect(entry.reason.trim()).not.toBe("");
		}
	});

	it("keeps closure, consumption and deferral sets unique and disjoint and never closes capability 140", () => {
		const closureIds = LINE11_WORKER_CAPABILITY_CLOSURES.map((entry) => entry.id);
		const deferredIds = LINE11_WORKER_DEFERRED_CAPABILITIES.map((entry) => entry.id);
		expect(new Set(closureIds).size).toBe(closureIds.length);
		expect(new Set(deferredIds).size).toBe(deferredIds.length);
		expect(closureIds.some((id) => deferredIds.includes(id))).toBe(false);
		expect([...closureIds, ...deferredIds]).not.toContain(140);
	});

	it("uses concrete owner and test evidence for every closure", () => {
		for (const entry of LINE11_WORKER_CAPABILITY_CLOSURES) {
			expect(entry.ownerModule.trim()).not.toBe("");
			expect(entry.publicContract.trim()).not.toBe("");
			expect(existsSync(resolve(REPOSITORY_ROOT, entry.ownerModule)), `missing owner for ${entry.id}`).toBe(true);
			expect(entry.tests.length).toBeGreaterThan(0);
			for (const test of entry.tests) {
				expect(existsSync(resolve(REPOSITORY_ROOT, test)), `missing test evidence for ${entry.id}: ${test}`).toBe(true);
			}
		}
	});

	it("records both sealed-contract omissions and all eight nonblockers without closing them", () => {
		expect(LINE11_WORKER_REVIEW_LEDGER.filter((entry) => entry.status === "fixed_sealed_contract_omission")).toHaveLength(2);
		expect(LINE11_WORKER_REVIEW_LEDGER.filter((entry) => entry.status === "nonblocking_follow_up")).toHaveLength(8);
		expect(LINE11_WORKER_REVIEW_LEDGER.map((entry) => entry.id)).toEqual([
			"foundation-canonical-worker-errors",
			"tool-gateway-worker-receipt-ref",
			"cancelled-without-proof-dead-code",
			"credential-target-registry-has-get",
			"revocation-unknown-quarantine",
			"credential-reason-propagation",
			"vm-qemu-sensitive-key-tests",
			"receipt-summary-wording",
			"session-create-provider-disposal",
			"registered-hooks-singleton",
		]);
	});

	it("does not mutate the sealed Foundation ledgers", () => {
		expect(FOUNDATION_V1_CAPABILITY_CLOSURES).toHaveLength(79);
		expect(FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS).toHaveLength(71);
		expect(foundationFutureOwnerById(140)?.laterOwner).toBe("11");
	});
});
