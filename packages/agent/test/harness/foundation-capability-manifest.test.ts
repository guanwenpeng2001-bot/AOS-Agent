import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	FOUNDATION_V1_CAPABILITY_CLOSURES,
	FOUNDATION_V1_CLOSURE_IDS,
	FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS,
	FOUNDATION_V1_FUTURE_IDS,
	type FoundationCapabilityClosureStatus,
	type FoundationHighLevelRow,
	type FoundationImplementationStage,
	type FoundationLaterConsumerLine,
} from "../../src/harness/foundation-v1-capabilities.ts";

const CLOSURE_STATUSES: readonly FoundationCapabilityClosureStatus[] = ["contract_drafted", "implemented", "regression_locked", "contract_sealed"];
const HIGH_LEVEL_ROWS: readonly FoundationHighLevelRow[] = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "10A"];
const LATER_LINES: readonly FoundationLaterConsumerLine[] = ["11", "12A", "12B", "13", "14", "15"];
const STAGES: readonly FoundationImplementationStage[] = [
	"T1",
	"T2",
	"T3",
	"T4",
	"T5",
	"T6",
	"T7",
	"T8",
	"T9",
	"T10",
	"T11",
	"T12",
];

const EXPECTED_CLOSURE_IDS: readonly number[] = [
	...range(1, 73),
	98,
	127,
	128,
	129,
	145,
	146,
];

const EXPECTED_FUTURE_IDS: readonly number[] = [
	...range(74, 97),
	...range(99, 126),
	...range(130, 144),
	...range(147, 150),
];

/**
 * Per-id high-level row mapping extracted from the Foundation seal PR
 * "高层行与能力映射" table. The manifest must reproduce it exactly so the
 * row-to-capability coverage stays machine-checkable.
 */
const EXPECTED_HIGH_LEVEL_ROWS: Readonly<Record<number, readonly FoundationHighLevelRow[]>> = {
	1: ["01", "03"],
	2: ["02"],
	3: ["01", "03"],
	4: ["02", "05", "09"],
	5: ["02", "08"],
	6: ["02", "04", "05", "06"],
	7: ["02", "04"],
	8: ["02", "09"],
	9: ["02"],
	10: ["02", "08"],
	11: ["09"],
	12: ["02"],
	13: ["02"],
	14: ["02", "10A"],
	15: ["02", "10A"],
	16: ["02", "07", "10A"],
	17: ["02"],
	18: ["02"],
	19: ["02"],
	20: ["02"],
	21: ["01", "10A"],
	22: ["01"],
	23: ["01"],
	24: ["01"],
	25: ["01"],
	26: ["01", "08", "10A"],
	27: ["01"],
	28: ["01"],
	29: ["02", "10"],
	30: ["02", "10"],
	31: ["02", "10"],
	32: ["09", "10"],
	33: ["10"],
	34: ["10"],
	35: ["02", "05"],
	36: ["02", "05"],
	37: ["02"],
	38: ["02", "10"],
	39: ["02", "10"],
	40: ["02", "03", "10"],
	41: ["02", "03", "10"],
	42: ["02", "10"],
	43: ["02", "10"],
	44: ["02", "10"],
	45: ["02", "03", "10"],
	46: ["02", "10"],
	47: ["01", "04", "08", "10A"],
	48: ["02", "06"],
	49: ["02"],
	50: ["02", "09"],
	51: ["02", "09"],
	52: ["02", "05", "06", "09", "10"],
	53: ["02", "09"],
	54: ["02", "07"],
	55: ["02", "08"],
	56: ["01", "07", "08", "10A"],
	57: ["01", "07", "08", "09", "10A"],
	58: ["01", "06", "07", "08"],
	59: ["01", "07", "08"],
	60: ["01", "03", "07", "08"],
	61: ["02", "04", "05", "06", "08"],
	62: ["09"],
	63: ["09"],
	64: ["09"],
	65: ["06", "09"],
	66: ["02", "09"],
	67: ["02", "06", "10A"],
	68: ["01", "03"],
	69: ["01", "03"],
	70: ["01", "03"],
	71: ["02"],
	72: ["01", "03"],
	73: ["02"],
	98: ["08", "10A"],
	127: ["08", "10A"],
	128: ["08", "10A"],
	129: ["08", "10A"],
	145: ["10A"],
	146: ["10A"],
};

/**
 * Later-owner line constraints per id range from the seal PR reverse-check
 * table. A future capability may only be owned by one of the lines listed for
 * its range.
 */
const EXPECTED_FUTURE_OWNER_LINES: Readonly<Record<string, readonly FoundationLaterConsumerLine[]>> = {
	"74-89": ["11", "14"],
	"90-97": ["12A"],
	"99-118": ["12A"],
	"119-126": ["12B"],
	"130-131": ["12B"],
	"132-144": ["11", "13", "14"],
	"147-150": ["14", "15"],
};

/**
 * Post-T0 stage-to-capability mapping, copied verbatim from the implementation
 * plan table ("能力编号到实施阶段的精确归属"). Ranges keep the en dash of the
 * source document. Overlaps across stages are integration work, not duplicate
 * implementation, so every closure may name several stages.
 */
const EXPECTED_STAGE_SPECS: Readonly<Record<FoundationImplementationStage, string>> = {
	T1: "1、3、12–13、21–28、40–41、47–49、56–60、67–70、72、98、146",
	T2: "14–16、19–28、36、40–41、47、49、53、56–60、67、70、72、127–129、145–146",
	T3: "1–10、13、21、25–28、35–36、40–41、45、47、49、59–61、68、73",
	T4: "4–7、29–46、51–52、61",
	T5: "12、17–20、22、24–25、28、49、53、57–58、67",
	T6: "8–11、13、29、38、44、48、50–52、58、65–66、71",
	T7: "14–16、21、26、47、54–57、67、73、98、127–129、145–146",
	T8: "4、6–11、16–18、29–34、47–66、68、71–73、98、145–146",
	T9: "1–3、14–16、21–27、29–31、40–45、47、68、70、73、145–146",
	T10: "1、3、27、40–41、45、59–60、68–72、145–146",
	T11: "6–7、19、21–28、36、40–41、47、53、56–61、67–72、127–129",
	T12: "1–73、98、127–129、145–146",
};

const EXPECTED_T4_CLOSURE_IDS: readonly number[] = [4, 5, 6, 7, ...range(29, 46), 51, 52, 61];

const EXPECTED_T4_CLOSURES: Readonly<Record<number, { closure: FoundationCapabilityClosureStatus; ownerModule: string; tests: readonly string[] }>> = {
	4: { closure: "contract_sealed", ownerModule: "packages/agent/src/harness/tool-gateway.ts", tests: ["packages/agent/test/harness/t4-tool-gateway.test.ts", "packages/agent/test/harness/t4-tool-runtime.test.ts", "packages/agent/test/harness/foundation-provider-conformance.test.ts"] },
	5: { closure: "implemented", ownerModule: "packages/agent/src/harness/tool-pipeline.ts", tests: ["packages/agent/test/harness/t4-tool-runtime.test.ts", "packages/coding-agent/test/rpc-task-graph.test.ts"] },
	6: { closure: "regression_locked", ownerModule: "packages/agent/src/harness/agent-harness.ts", tests: ["packages/agent/test/harness/agent-harness-runtime.test.ts", "packages/coding-agent/test/run-lifecycle.test.ts", "packages/coding-agent/test/rpc-tcp-cancel-idempotency.test.ts"] },
	7: { closure: "regression_locked", ownerModule: "packages/agent/src/agent-errors.ts", tests: ["packages/agent/test/agent-loop-errors.test.ts", "packages/agent/test/harness/recovery-conformance.test.ts"] },
	29: { closure: "regression_locked", ownerModule: "packages/agent/src/harness/skills.ts", tests: ["packages/agent/test/harness/skills.test.ts", "packages/coding-agent/test/sdk-skills.test.ts"] },
	30: { closure: "regression_locked", ownerModule: "packages/agent/src/harness/runtime-services.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts", "packages/coding-agent/test/agent-session-capabilities.test.ts"] },
	31: { closure: "implemented", ownerModule: "packages/agent/src/harness/runtime-services.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts", "packages/coding-agent/test/agent-session-dynamic-tools.test.ts"] },
	32: { closure: "contract_sealed", ownerModule: "packages/coding-agent/src/core/mcp-tool-adapter.ts", tests: ["packages/coding-agent/test/mcp-lifecycle.test.ts", "packages/coding-agent/test/mcp-tool-adapter.test.ts"] },
	33: { closure: "regression_locked", ownerModule: "packages/coding-agent/src/core/mcp-lifecycle.ts", tests: ["packages/coding-agent/test/mcp-auth.test.ts", "packages/coding-agent/test/mcp-resource-prompt.test.ts"] },
	34: { closure: "contract_sealed", ownerModule: "packages/agent/src/harness/foundation/binding.ts", tests: ["packages/agent/test/harness/foundation-contracts.test.ts", "packages/agent/test/harness/foundation-provider-conformance.test.ts", "packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	35: { closure: "implemented", ownerModule: "packages/agent/src/harness/tool-pipeline.ts", tests: ["packages/agent/test/harness/t4-tool-runtime.test.ts", "packages/agent/test/harness/t4-tool-gateway.test.ts", "packages/agent/test/harness/t4-agent-harness-pipeline.test.ts"] },
	36: { closure: "implemented", ownerModule: "packages/agent/src/harness/tool-pipeline.ts", tests: ["packages/agent/test/harness/t4-tool-runtime.test.ts", "packages/agent/test/harness/t4-agent-harness-pipeline.test.ts"] },
	37: { closure: "implemented", ownerModule: "packages/agent/src/harness/runtime-services.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	38: { closure: "implemented", ownerModule: "packages/agent/src/harness/profile.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	39: { closure: "implemented", ownerModule: "packages/agent/src/harness/runtime-services.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	40: { closure: "implemented", ownerModule: "packages/agent/src/harness/events.ts", tests: ["packages/agent/test/harness/events.test.ts"] },
	41: { closure: "implemented", ownerModule: "packages/agent/src/harness/events.ts", tests: ["packages/agent/test/harness/events.test.ts"] },
	42: { closure: "implemented", ownerModule: "packages/agent/src/harness/plugins.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	43: { closure: "contract_sealed", ownerModule: "packages/agent/src/harness/plugins.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	44: { closure: "regression_locked", ownerModule: "packages/agent/src/harness/foundation/role-registry.ts", tests: ["packages/agent/test/harness/foundation-contracts.test.ts", "packages/agent/test/harness/t4-runtime-lifecycle.test.ts"] },
	45: { closure: "contract_drafted", ownerModule: "packages/coding-agent/src/core/agent-session.ts", tests: ["packages/coding-agent/test/suite/agent-session-runtime.test.ts", "packages/coding-agent/test/agent-session-capabilities.test.ts"] },
	46: { closure: "contract_sealed", ownerModule: "packages/agent/src/harness/runtime-services.ts", tests: ["packages/agent/test/harness/t4-runtime-lifecycle.test.ts", "packages/agent/test/harness/events.test.ts", "packages/agent/test/harness/foundation-provider-conformance.test.ts"] },
	51: { closure: "contract_drafted", ownerModule: "packages/coding-agent/src/core/capability-registry.ts", tests: ["packages/coding-agent/test/capability-registry.test.ts", "packages/agent/test/harness/foundation-provider-conformance.test.ts"] },
	52: { closure: "contract_drafted", ownerModule: "packages/coding-agent/src/core/execution-policy.ts", tests: ["packages/coding-agent/test/execution-policy-contract.test.ts", "packages/coding-agent/test/execution-policy.test.ts"] },
	61: { closure: "regression_locked", ownerModule: "packages/agent/src/harness/tool-pipeline.ts", tests: ["packages/agent/test/harness/t4-tool-runtime.test.ts", "packages/agent/test/harness/recovery-conformance.test.ts"] },
};

const EXPECTED_T5_CLOSURE_IDS: readonly number[] = [12, 17, 18, 19, 20, 22, 24, 25, 28, 49, 53, 57, 58, 67];

const EXPECTED_T5_CLOSURES: Readonly<Record<number, { closure: FoundationCapabilityClosureStatus; ownerModule: string; tests: readonly string[] }>> = {
	12: {
		closure: "implemented",
		ownerModule: "packages/agent/src/harness/artifacts.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/agent-harness-runtime.test.ts",
			"packages/agent/test/harness/foundation-provider-conformance.test.ts",
			"packages/agent/test/agent-loop.test.ts",
		],
	},
	17: {
		closure: "contract_sealed",
		ownerModule: "packages/agent/src/harness/context/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
		],
	},
	18: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/context/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
			"packages/coding-agent/test/context-engine.test.ts",
		],
	},
	19: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/compaction/compaction.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/compaction.test.ts",
			"packages/agent/test/harness/recovery-conformance.test.ts",
		],
	},
	20: {
		closure: "implemented",
		ownerModule: "packages/agent/src/harness/memory/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
			"packages/agent/test/harness/session/memory.test.ts",
		],
	},
	22: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/session/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/branch-summarization.test.ts",
			"packages/coding-agent/test/rpc-client-clone.test.ts",
		],
	},
	24: {
		closure: "implemented",
		ownerModule: "packages/agent/src/harness/compaction/compaction.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/recovery-conformance.test.ts",
			"packages/agent/test/harness/compaction.test.ts",
		],
	},
	25: {
		closure: "implemented",
		ownerModule: "packages/agent/src/harness/reducer.ts",
		tests: [
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/recovery-conformance.test.ts",
			"packages/agent/test/harness/reducer.test.ts",
		],
	},
	28: {
		closure: "contract_sealed",
		ownerModule: "packages/agent/src/harness/context/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
			"packages/agent/test/harness/events.test.ts",
			"packages/agent/test/harness/foundation-provider-conformance.test.ts",
		],
	},
	49: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/context/index.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
		],
	},
	53: {
		closure: "regression_locked",
		ownerModule: "packages/coding-agent/src/core/execution-audit.ts",
		tests: ["packages/coding-agent/test/execution-audit-contract.test.ts", "packages/coding-agent/test/execution-audit-query.test.ts"],
	},
	57: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/foundation/identity.ts",
		tests: [
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/recovery-conformance.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
			"packages/coding-agent/test/rpc-task-graph.test.ts",
		],
	},
	58: {
		closure: "regression_locked",
		ownerModule: "packages/agent/src/harness/foundation/identity.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/foundation-contracts.test.ts",
			"packages/agent/test/harness/foundation-provider-conformance.test.ts",
			"packages/agent/test/harness/recovery-conformance.test.ts",
		],
	},
	67: {
		closure: "implemented",
		ownerModule: "packages/agent/src/harness/artifacts.ts",
		tests: [
			"packages/agent/test/harness/context-t5-ledger.test.ts",
			"packages/agent/test/harness/context-t5-regressions.test.ts",
			"packages/agent/test/harness/foundation-provider-conformance.test.ts",
		],
	},
};

/** Future Role-related capabilities that must explicitly consume role contracts in their upstream list. */
const FUTURE_ROLE_CONTRACT_IDS = [91, 96, 109, 110, 132, 138, 147];

/** Future result-related capabilities that must explicitly consume result contracts in their upstream list. */
const FUTURE_RESULT_CONTRACT_IDS = [99, 100, 101, 122, 123, 124, 125, 126];

const ROLE_CONTRACT_TOKENS = ["RoleDefinition", "RoleRevision", "ModelProfile", "AgentBinding", "BindingEpoch"];

const RESULT_CONTRACT_TOKENS = ["AttemptReceipt", "TaskResult", "RunReceipt", "Artifact"];
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function range(start: number, end: number): number[] {
	const ids: number[] = [];
	for (let id = start; id <= end; id++) ids.push(id);
	return ids;
}

/** Expand a plan-table spec like "1–3、12–13" into the sorted id list it denotes. */
function expandStageSpec(spec: string): number[] {
	const ids: number[] = [];
	for (const part of spec.split("、")) {
		const match = /^(\d+)(?:–(\d+))?$/.exec(part);
		expect(match, `malformed stage spec part "${part}"`).not.toBeNull();
		const m = match as RegExpExecArray;
		const start = Number(m[1]);
		const end = m[2] === undefined ? start : Number(m[2]);
		for (let id = start; id <= end; id++) ids.push(id);
	}
	return ids;
}

function futureOwnerLinesFor(id: number): readonly FoundationLaterConsumerLine[] {
	if (id >= 74 && id <= 89) return EXPECTED_FUTURE_OWNER_LINES["74-89"];
	if (id >= 90 && id <= 97) return EXPECTED_FUTURE_OWNER_LINES["90-97"];
	if (id >= 99 && id <= 118) return EXPECTED_FUTURE_OWNER_LINES["99-118"];
	if (id >= 119 && id <= 126) return EXPECTED_FUTURE_OWNER_LINES["119-126"];
	if (id >= 130 && id <= 131) return EXPECTED_FUTURE_OWNER_LINES["130-131"];
	if (id >= 132 && id <= 144) return EXPECTED_FUTURE_OWNER_LINES["132-144"];
	if (id >= 147 && id <= 150) return EXPECTED_FUTURE_OWNER_LINES["147-150"];
	return [];
}

describe("Foundation v1 capability manifest", () => {
	it("contains exactly 79 closure ids covering 1..73, 98, 127, 128, 129, 145, 146", () => {
		expect(FOUNDATION_V1_CAPABILITY_CLOSURES).toHaveLength(79);
		const ids = FOUNDATION_V1_CAPABILITY_CLOSURES.map((entry) => entry.id);
		expect(ids.slice().sort((a, b) => a - b)).toEqual(EXPECTED_CLOSURE_IDS);
		expect(FOUNDATION_V1_CLOSURE_IDS.size).toBe(79);
	});

	it("contains exactly 71 future owner ids covering 74..97, 99..126, 130..144, 147..150", () => {
		expect(FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS).toHaveLength(71);
		const ids = FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS.map((entry) => entry.id);
		expect(ids.slice().sort((a, b) => a - b)).toEqual(EXPECTED_FUTURE_IDS);
		expect(FOUNDATION_V1_FUTURE_IDS.size).toBe(71);
	});

	it("has no duplicate ids within either ledger", () => {
		const closureIds = FOUNDATION_V1_CAPABILITY_CLOSURES.map((entry) => entry.id);
		const futureIds = FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS.map((entry) => entry.id);
		expect(new Set(closureIds).size).toBe(closureIds.length);
		expect(new Set(futureIds).size).toBe(futureIds.length);
	});

	it("covers 1..150 exactly as the disjoint union of closures and future owners", () => {
		const allIds = new Set([...FOUNDATION_V1_CLOSURE_IDS, ...FOUNDATION_V1_FUTURE_IDS]);
		expect(FOUNDATION_V1_CLOSURE_IDS.size + FOUNDATION_V1_FUTURE_IDS.size).toBe(150);
		for (let id = 1; id <= 150; id++) {
			expect(allIds.has(id), `capability id ${id} must be covered exactly once`).toBe(true);
		}
		expect([...allIds].sort((a, b) => a - b)).toEqual(range(1, 150));
	});

	it("fills nonempty owner, rows, tests and description metadata on every entry", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			expect(entry.ownerModule.trim(), `closure ${entry.id} needs an owner module`).not.toBe("");
			expect(entry.highLevelRows.length, `closure ${entry.id} needs high-level rows`).toBeGreaterThan(0);
			expect(entry.tests.length, `closure ${entry.id} needs tests`).toBeGreaterThan(0);
			for (const test of entry.tests) expect(test.trim(), `closure ${entry.id} has an empty test reference`).not.toBe("");
			expect(entry.publicContract?.trim().length ?? 0, `closure ${entry.id} publicContract must not be blank`).toBeGreaterThan(0);
		}
		for (const entry of FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS) {
			expect(entry.title.trim(), `future ${entry.id} needs a title`).not.toBe("");
			expect(entry.description.trim(), `future ${entry.id} needs a description`).not.toBe("");
			expect(
				entry.consumedFoundationContracts.length,
				`future ${entry.id} must name at least one upstream Foundation contract`,
			).toBeGreaterThan(0);
			for (const contract of entry.consumedFoundationContracts) {
				expect(contract.trim(), `future ${entry.id} has an empty consumed contract`).not.toBe("");
			}
		}
	});

	it("resolves every ownerModule and test reference to an existing repository path", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			expect(existsSync(resolve(REPOSITORY_ROOT, entry.ownerModule)), `closure ${entry.id} ownerModule is missing: ${entry.ownerModule}`).toBe(true);
			for (const test of entry.tests) expect(existsSync(resolve(REPOSITORY_ROOT, test)), `closure ${entry.id} test path is missing: ${test}`).toBe(true);
		}
	});

	it("uses only the declared closure statuses, high-level rows and later lines", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			expect(CLOSURE_STATUSES).toContain(entry.closure);
			for (const row of entry.highLevelRows) expect(HIGH_LEVEL_ROWS).toContain(row);
			if (entry.laterConsumer !== undefined) expect(LATER_LINES).toContain(entry.laterConsumer);
		}
		for (const entry of FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS) {
			expect(LATER_LINES).toContain(entry.laterOwner);
		}
	});

	it("rejects duplicate test references within one closure entry", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			expect(new Set(entry.tests).size, `closure ${entry.id} repeats a test reference`).toBe(entry.tests.length);
		}
	});

	it("matches the complete T4 status and evidence manifest", () => {
		const actual = FOUNDATION_V1_CAPABILITY_CLOSURES
			.filter((entry) => EXPECTED_T4_CLOSURE_IDS.includes(entry.id))
			.sort((a, b) => a.id - b.id);
		expect(actual.map((entry) => entry.id)).toEqual(EXPECTED_T4_CLOSURE_IDS);
		for (const entry of actual) {
			const expected = EXPECTED_T4_CLOSURES[entry.id];
			expect(expected, `T4 closure ${entry.id} is missing its expected manifest row`).toBeDefined();
			if (expected === undefined) continue;
			expect(entry.closure, `T4 closure ${entry.id} status mismatch`).toBe(expected.closure);
			expect(entry.ownerModule, `T4 closure ${entry.id} owner mismatch`).toBe(expected.ownerModule);
			expect(entry.tests, `T4 closure ${entry.id} test evidence mismatch`).toEqual(expected.tests);
			expect(existsSync(resolve(REPO_ROOT, expected.ownerModule)), `T4 closure ${entry.id} owner path is missing`).toBe(true);
			for (const test of expected.tests) expect(existsSync(resolve(REPO_ROOT, test)), `T4 closure ${entry.id} test path is missing: ${test}`).toBe(true);
		}
	});

	it("matches the complete T5 status, owner, and evidence manifest", () => {
		const actual = FOUNDATION_V1_CAPABILITY_CLOSURES
			.filter((entry) => EXPECTED_T5_CLOSURE_IDS.includes(entry.id))
			.sort((a, b) => a.id - b.id);
		expect(actual.map((entry) => entry.id)).toEqual(EXPECTED_T5_CLOSURE_IDS);
		for (const entry of actual) {
			const expected = EXPECTED_T5_CLOSURES[entry.id];
			expect(expected, `T5 closure ${entry.id} is missing its expected manifest row`).toBeDefined();
			if (expected === undefined) continue;
			expect(entry.closure, `T5 closure ${entry.id} status mismatch`).toBe(expected.closure);
			expect(entry.ownerModule, `T5 closure ${entry.id} owner mismatch`).toBe(expected.ownerModule);
			expect(entry.tests, `T5 closure ${entry.id} test evidence mismatch`).toEqual(expected.tests);
			expect(existsSync(resolve(REPO_ROOT, expected.ownerModule)), `T5 closure ${entry.id} owner path is missing`).toBe(true);
			for (const test of expected.tests) expect(existsSync(resolve(REPO_ROOT, test)), `T5 closure ${entry.id} test path is missing: ${test}`).toBe(true);
		}
	});

	it("matches the seal PR high-level row mapping exactly", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			const expected = EXPECTED_HIGH_LEVEL_ROWS[entry.id];
			expect(expected, `closure ${entry.id} has no expected row mapping`).toBeDefined();
			expect(entry.highLevelRows.slice().sort(), `closure ${entry.id} row mismatch`).toEqual(expected.slice().sort());
		}
		// Every row and row 10A is covered by at least one closure.
		const coveredRows = new Set(FOUNDATION_V1_CAPABILITY_CLOSURES.flatMap((entry) => entry.highLevelRows));
		expect([...coveredRows].sort()).toEqual(HIGH_LEVEL_ROWS.slice().sort());
		expect(coveredRows.has("10A")).toBe(true);
	});

	it("gives every closure a nonempty implementation-stage set restricted to T1..T12", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			expect(
				entry.implementationStages.length,
				`closure ${entry.id} needs at least one post-T0 implementation stage`,
			).toBeGreaterThan(0);
			for (const stage of entry.implementationStages) {
				expect(STAGES, `closure ${entry.id} uses unknown stage ${stage}`).toContain(stage);
			}
			expect(
				new Set(entry.implementationStages).size,
				`closure ${entry.id} repeats an implementation stage`,
			).toBe(entry.implementationStages.length);
		}
	});

	it("inverts the per-entry stage mapping to exactly the implementation plan table", () => {
		for (const stage of STAGES) {
			const expected = expandStageSpec(EXPECTED_STAGE_SPECS[stage]);
			const actual = FOUNDATION_V1_CAPABILITY_CLOSURES.filter((entry) =>
				entry.implementationStages.includes(stage),
			)
				.map((entry) => entry.id)
				.sort((a, b) => a - b);
			expect(actual, `stage ${stage} id set mismatch against the plan table`).toEqual(expected);
		}
	});

	it("covers every post-T0 stage by at least one closure and seals the full closure set at T12", () => {
		const coveredStages = new Set(FOUNDATION_V1_CAPABILITY_CLOSURES.flatMap((entry) => entry.implementationStages));
		expect([...coveredStages].sort()).toEqual(STAGES.slice().sort());
		const sealIds = FOUNDATION_V1_CAPABILITY_CLOSURES.filter((entry) => entry.implementationStages.includes("T12"))
			.map((entry) => entry.id)
			.sort((a, b) => a - b);
		expect(sealIds).toEqual(EXPECTED_CLOSURE_IDS);
	});

	it("requires a public contract for every contract_sealed closure", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			if (entry.closure !== "contract_sealed") continue;
			expect(entry.publicContract, `contract_sealed closure ${entry.id} needs a public contract`).toBeDefined();
			expect(entry.publicContract!.trim(), `contract_sealed closure ${entry.id} needs a public contract`).not.toBe("");
		}
	});

	it("seals C011 and C050 at the gateway layer while leaving ModelBroker composition to T8", () => {
		const c011 = FOUNDATION_V1_CAPABILITY_CLOSURES.find((entry) => entry.id === 11);
		const c050 = FOUNDATION_V1_CAPABILITY_CLOSURES.find((entry) => entry.id === 50);
		expect(c011).toMatchObject({ closure: "contract_sealed", ownerModule: "packages/agent/src/harness/foundation/gateway.ts" });
		expect(c050).toMatchObject({ closure: "contract_sealed", ownerModule: "packages/agent/src/harness/foundation/gateway.ts" });
		for (const entry of [c011, c050]) {
			expect(entry?.tests).toContain("packages/agent/test/harness/t6-executor-gateway-conformance.test.ts");
			expect(entry?.publicContract).toContain("ScopedExecutionGateway");
			expect(entry?.publicContract).toContain("ScopedModelGateway");
		}
		expect(c050?.laterConsumer).toBe("13");
	});

	it("never claims a later provider as closed, and future-only ids stay within the owned capability space", () => {
		for (const entry of FOUNDATION_V1_CAPABILITY_CLOSURES) {
			if (entry.laterConsumer === undefined) continue;
			expect(entry.laterCapabilityIds?.length ?? 0, `closure ${entry.id} with a later consumer must list later capability ids`).toBeGreaterThan(0);
			for (const laterId of entry.laterCapabilityIds ?? []) {
				expect(laterId, `closure ${entry.id} later id ${laterId} out of the 1..150 capability space`).toBeGreaterThanOrEqual(1);
				expect(laterId, `closure ${entry.id} later id ${laterId} out of the 1..150 capability space`).toBeLessThanOrEqual(150);
			}
		}
	});

	it("keeps every future owner on a later line allowed for its id range", () => {
		for (const entry of FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS) {
			const allowed = futureOwnerLinesFor(entry.id);
			expect(allowed.length).toBeGreaterThan(0);
			expect(allowed).toContain(entry.laterOwner);
		}
	});

	it("explicitly lists role upstream contracts for future Role ids 91, 96, 109, 110, 132, 138, 147", () => {
		for (const id of FUTURE_ROLE_CONTRACT_IDS) {
			const entry = FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS.find((owner) => owner.id === id);
			expect(entry, `future role id ${id} must exist as an explicit owner`).toBeDefined();
			const consumed = entry!.consumedFoundationContracts.join(" ");
			const hasRoleContract = ROLE_CONTRACT_TOKENS.some((token) => consumed.includes(token));
			expect(hasRoleContract, `future role id ${id} must consume a role contract (RoleRevision/ModelProfile/AgentBinding/BindingEpoch)`).toBe(true);
		}
	});

	it("explicitly lists result upstream contracts for future result ids 99..101 and 122..126", () => {
		for (const id of FUTURE_RESULT_CONTRACT_IDS) {
			const entry = FOUNDATION_V1_FUTURE_CAPABILITY_OWNERS.find((owner) => owner.id === id);
			expect(entry, `future result id ${id} must exist as an explicit owner`).toBeDefined();
			const consumed = entry!.consumedFoundationContracts.join(" ");
			const hasResultContract = RESULT_CONTRACT_TOKENS.some((token) => consumed.includes(token));
			expect(hasResultContract, `future result id ${id} must consume a result contract (AttemptReceipt/TaskResult/RunReceipt/Artifact)`).toBe(true);
		}
	});
});
