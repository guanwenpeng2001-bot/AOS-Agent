import { readFileSync } from "node:fs";
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

function readRepositoryEvidence(path: string): string {
	return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

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
	111: {
		status: "partial",
		claims: ["native-provider-registry", "native-provider-local-availability"],
		deferred: [{ claim: "remote-native-provider-availability", owner: "14" }],
	},
	113: {
		status: "partial",
		claims: ["internal-continuation", "external-continuation"],
		deferred: [{ claim: "cross-host-continuation", owner: "14" }],
	},
	114: {
		status: "partial",
		claims: ["internal-task-executor-admission", "external-task-executor-admission"],
		deferred: [{ claim: "cross-host-task-executor-fleet", owner: "14" }],
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
		deferred: [
			{ claim: "external-credential-target", owner: "T9" },
			{ claim: "production-credential-target", owner: "14" },
		],
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

function evidenceByClaim(row: Record<string, unknown>, claim: string): Record<string, unknown> {
	const evidence = row.evidence as Array<Record<string, unknown>>;
	const match = evidence.find((entry) => entry.claim === claim);
	if (match === undefined) throw new Error(`missing evidence ${claim}`);
	return match;
}

function rebuildDescription(row: Record<string, unknown>): void {
	const evidence = row.evidence as Array<{ behavior: string }>;
	const deferred = row.deferred as Array<{ behavior: string; owner: string }>;
	const implemented = `Implemented: ${evidence.map((entry) => entry.behavior).join(" ")}`;
	row.description = deferred.length === 0
		? implemented
		: `${implemented} Deferred: ${deferred.map((entry) => `${entry.behavior} [${entry.owner}]`).join(" ")}`;
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
		expect(() => verifyLine13T5CapabilityManifest(LINE13_T5_CAPABILITY_TRUTH, readRepositoryEvidence)).not.toThrow();
	});

	it("proves every claim from executable owner and focused test semantics", () => {
		expect(() => verifyLine13T5CapabilityManifest(LINE13_T5_CAPABILITY_TRUTH, readRepositoryEvidence)).not.toThrow();
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

	it("rejects description overclaim and missing claims", () => {
		const overclaim = mutableManifest();
		rowById(overclaim, 69).description = `${String(rowById(overclaim, 69).description)} WebSocket is implemented.`;
		expect(() => verifyLine13T5CapabilityManifest(overclaim, readRepositoryEvidence)).toThrow(
			"description must be derived",
		);

		const missingClaim = mutableManifest();
		const mcpRow = rowById(missingClaim, 138);
		mcpRow.evidence = (mcpRow.evidence as Array<Record<string, unknown>>).slice(0, 3);
		expect(() => verifyLine13T5CapabilityManifest(missingClaim, readRepositoryEvidence)).toThrow(
			"implemented claim set",
		);
	});

	it("rejects partial or unavailable behavior promoted to implemented", () => {
		const inflated = mutableManifest();
		rowById(inflated, 111).status = "implemented";
		expect(() => verifyLine13T5CapabilityManifest(inflated, readRepositoryEvidence)).toThrow("status must be partial");

		const unavailable = mutableManifest();
		const localAvailability = evidenceByClaim(rowById(unavailable, 111), "native-provider-local-availability");
		localAvailability.behavior = "The remote agent_runtime_host provider is unavailable.";
		rebuildDescription(rowById(unavailable, 111));
		expect(() => verifyLine13T5CapabilityManifest(unavailable, readRepositoryEvidence)).toThrow(
			"describes unavailable behavior as implemented",
		);
	});

	it("rejects altered behavior, an existing but wrong owner, and irrelevant existing tests", () => {
		const alteredBehavior = mutableManifest();
		const continuation = evidenceByClaim(rowById(alteredBehavior, 113), "external-continuation");
		continuation.behavior = "External continuation starts a replacement vendor attempt after restart.";
		rebuildDescription(rowById(alteredBehavior, 113));
		expect(() => verifyLine13T5CapabilityManifest(alteredBehavior, readRepositoryEvidence)).toThrow(
			"behavior does not match executable semantics",
		);

		const wrongOwner = mutableManifest();
		evidenceByClaim(rowById(wrongOwner, 132), "execution-policy-reference").ownerModule =
			"packages/coding-agent/src/core/execution-policy.ts";
		expect(() => verifyLine13T5CapabilityManifest(wrongOwner, readRepositoryEvidence)).toThrow(
			"owner does not implement the claimed behavior",
		);

		const irrelevantTests = mutableManifest();
		evidenceByClaim(rowById(irrelevantTests, 136), "worker-credential-target").tests = [
			"packages/coding-agent/test/external-agent-integration.test.ts",
		];
		expect(() => verifyLine13T5CapabilityManifest(irrelevantTests, readRepositoryEvidence)).toThrow(
			"tests do not match executable evidence",
		);
	});

	it("rejects evidence files whose required behavioral assertion is removed", () => {
		const targetPath = "packages/coding-agent/test/external-agent-connector-lifecycle.test.ts";
		const marker = `it("resumes only an existing mapped Attempt when capability is supported"`;
		const mutatedReader = (path: string): string => {
			const content = readRepositoryEvidence(path);
			return path === targetPath ? content.replace(marker, "removed semantic regression") : content;
		};
		expect(() => verifyLine13T5CapabilityManifest(LINE13_T5_CAPABILITY_TRUTH, mutatedReader)).toThrow(
			"is missing semantic marker",
		);
	});
});
