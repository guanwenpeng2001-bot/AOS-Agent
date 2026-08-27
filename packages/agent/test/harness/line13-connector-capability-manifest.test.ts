import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foundationClosureById, foundationFutureOwnerById } from "../../src/harness/foundation-capabilities.ts";
import { LINE12A_SUBAGENT_CAPABILITY_CLOSURES } from "../../src/harness/line12a-subagent-capabilities.ts";
import {
	LINE13_T5_CAPABILITY_IDS,
	LINE13_T5_CAPABILITY_TRUTH,
	verifyLine13T5CapabilityManifest,
} from "../../src/harness/line13-connector-capabilities.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const EXPECTED = {
	23: {
		status: "partial",
		claims: ["session-metadata-persistence"],
		deferred: [{ claim: "session-product-organization", owner: "15" }],
	},
	69: {
		status: "partial",
		claims: ["rpc-stdio-jsonl", "rpc-loopback-tcp-jsonl"],
		deferred: [{ claim: "rpc-remote-transport-hardening", owner: "14" }],
	},
	111: { status: "implemented", claims: ["native-provider-registry", "native-provider-availability"], deferred: [] },
	113: { status: "implemented", claims: ["internal-continuation", "external-continuation"], deferred: [] },
	114: {
		status: "implemented",
		claims: ["internal-task-executor-admission", "external-task-executor-admission"],
		deferred: [],
	},
	132: {
		status: "implemented",
		claims: ["execution-policy-reference", "seven-resource-child-projection"],
		deferred: [],
	},
	133: {
		status: "implemented",
		claims: [
			"canonical-protected-paths",
			"structured-effects-and-review",
			"managed-team-review",
			"durable-review-evidence",
		],
		deferred: [],
	},
	135: {
		status: "partial",
		claims: ["worker-two-phase-execution", "external-two-phase-admission"],
		deferred: [{ claim: "production-runner-hardening", owner: "14" }],
	},
	136: {
		status: "partial",
		claims: ["worker-credential-target"],
		deferred: [{ claim: "external-credential-target", owner: "T9" }],
	},
	138: {
		status: "implemented",
		claims: [
			"exact-mcp-selection",
			"connector-route-intersection",
			"child-mcp-no-widen",
			"durable-mcp-inheritance-approval",
		],
		deferred: [],
	},
} as const;

function mutableManifest(): Array<Record<string, unknown>> {
	return LINE13_T5_CAPABILITY_TRUTH.map((row) => ({
		...row,
		evidence: row.evidence.map((entry) => ({ ...entry, tests: [...entry.tests] })),
		deferred: row.deferred.map((entry) => ({ ...entry })),
	}));
}

function rowById(manifest: Array<Record<string, unknown>>, id: number): Record<string, unknown> {
	const row = manifest.find((entry) => entry.id === id);
	if (row === undefined) throw new Error(`missing capability ${id}`);
	return row;
}

describe("Line 13 T5 capability truth manifest", () => {
	it("records the exact repaired ids, statuses, evidenced claims, and deferred owners", () => {
		expect(LINE13_T5_CAPABILITY_TRUTH.map((row) => row.id)).toEqual(LINE13_T5_CAPABILITY_IDS);
		for (const row of LINE13_T5_CAPABILITY_TRUTH) {
			const expected = EXPECTED[row.id];
			expect(row.status, `capability ${row.id} status`).toBe(expected.status);
			expect(
				row.evidence.map((entry) => entry.claim),
				`capability ${row.id} claims`,
			).toEqual(expected.claims);
			expect(
				row.deferred.map(({ claim, owner }) => ({ claim, owner })),
				`capability ${row.id} deferred`,
			).toEqual(expected.deferred);
		}
		expect(() => verifyLine13T5CapabilityManifest(LINE13_T5_CAPABILITY_TRUTH)).not.toThrow();
	});

	it("binds every implemented behavior to existing owner and test paths", () => {
		for (const row of LINE13_T5_CAPABILITY_TRUTH) {
			for (const evidence of row.evidence) {
				expect(
					existsSync(resolve(REPOSITORY_ROOT, evidence.ownerModule)),
					`capability ${row.id} owner ${evidence.ownerModule}`,
				).toBe(true);
				expect(evidence.tests.length, `capability ${row.id} claim ${evidence.claim}`).toBeGreaterThan(0);
				for (const test of evidence.tests) {
					expect(existsSync(resolve(REPOSITORY_ROOT, test)), `capability ${row.id} evidence ${test}`).toBe(true);
				}
			}
		}
	});

	it("keeps the baseline and Line 12A descriptions inside their evidenced scope", () => {
		expect(foundationClosureById(23)?.publicContract).toBe(
			"Canonical Session metadata records with durable persistence and runtime recovery",
		);
		expect(foundationClosureById(69)?.publicContract).toBe(
			"stdio and loopback-only TCP JSONL transports with bounded framing",
		);
		expect(foundationClosureById(69)?.publicContract).not.toMatch(/WebSocket|auth|TLS/);

		const providerOwner = foundationFutureOwnerById(111);
		expect(providerOwner?.description).toContain("in-process and fork are available");
		expect(providerOwner?.description).toContain("Agent Runtime Host is explicitly unavailable");
		expect(providerOwner?.description).toContain("external connectors use a separate provider contract");
		const providerClosure = LINE12A_SUBAGENT_CAPABILITY_CLOSURES.find((entry) => entry.id === 111);
		expect(providerClosure?.publicContract).toContain("in-process and fork available");
		expect(providerClosure?.publicContract).toContain("Agent Runtime Host unavailable");

		expect(foundationFutureOwnerById(132)?.description).toContain("Canonical ExecutionPolicy references");
		expect(foundationFutureOwnerById(132)?.description).not.toContain("permission matrix (read");
		expect(foundationFutureOwnerById(136)?.description).toContain(
			"external Agent credential targets remain deferred to T9",
		);
	});

	it("rejects description overclaim, missing claims, status inflation, and narrower test evidence", () => {
		const overclaim = mutableManifest();
		rowById(overclaim, 69).description = `${String(rowById(overclaim, 69).description)} WebSocket is implemented.`;
		expect(() => verifyLine13T5CapabilityManifest(overclaim)).toThrow("description must be derived");

		const missingClaim = mutableManifest();
		const mcpRow = rowById(missingClaim, 138);
		mcpRow.evidence = (mcpRow.evidence as Array<Record<string, unknown>>).slice(0, 3);
		expect(() => verifyLine13T5CapabilityManifest(missingClaim)).toThrow("implemented claim set");

		const inflated = mutableManifest();
		rowById(inflated, 136).status = "implemented";
		expect(() => verifyLine13T5CapabilityManifest(inflated)).toThrow("status must be partial");

		const narrowerEvidence = mutableManifest();
		const continuationRow = rowById(narrowerEvidence, 113);
		const continuationEvidence = continuationRow.evidence as Array<Record<string, unknown>>;
		const external = continuationEvidence.find((entry) => entry.claim === "external-continuation");
		if (external === undefined) throw new Error("missing external continuation evidence");
		external.tests = ["packages/coding-agent/test/subagent-fork-provider.test.ts"];
		expect(() => verifyLine13T5CapabilityManifest(narrowerEvidence)).toThrow("is missing required test");
	});
});
