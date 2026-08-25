import { expect, test } from "vitest";
import {
	LINE13_FINAL_KNOWN_GAP_CASE_SHARDS,
	LINE13_FINAL_KNOWN_GAP_CASES,
	LINE13_FINAL_RESOLVED_CASES,
	loadLine13FinalKnownGapManifest,
	loadLine13FinalKnownGapTransition,
} from "./support/line13-final-known-gap-manifest.ts";
import {
	defineLine13KnownGapCase,
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
	fingerprintLine13Failure,
	LINE13_AC_IDS,
	LINE13_KNOWN_GAP_SHARD_IDS,
	LINE13_OWNER_STAGES,
	LINE13_T0_BASE_SHA,
	loadLine13KnownGapManifest,
	loadLine13KnownGapTransition,
	registerLine13KnownGapCase,
	registerLine13KnownGapCaseWith,
	registerLine13ResolvedCase,
	registerLine13ResolvedCaseWith,
	type Line13ExpectedFailureTestApi,
	type Line13KnownGapScenario,
} from "./support/line13-known-gaps.ts";

interface CapturedTest {
	name: string;
	body: () => void | Promise<void>;
}

interface CapturedTests {
	api: Line13ExpectedFailureTestApi;
	normal: CapturedTest[];
	fails: CapturedTest[];
}

function assertionFailure(message: string): Error & Record<string, unknown> {
	const failure = new Error(message) as Error & Record<string, unknown>;
	failure.name = "AssertionError";
	failure.actual = "actual";
	failure.expected = "expected";
	failure.showDiff = true;
	failure.operator = "strictEqual";
	return failure;
}

const EXPECTED_REASON = "connector.lifecycle";
const EXPECTED_ASSERTION = assertionFailure("expected connector lifecycle to be persisted");
const EXPECTED_FINGERPRINT = fingerprintLine13Failure(EXPECTED_REASON, EXPECTED_ASSERTION);

function knownGapEntry(ac: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ac,
		fullTestName: `Line 13 expected failure for ${ac}`,
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T3a",
		mode: "fails",
		expectedFailure: {
			reason: EXPECTED_REASON,
			fingerprint: EXPECTED_FINGERPRINT,
		},
		...overrides,
	};
}

function knownGapCase(ac: string, entryOverrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		entry: knownGapEntry(ac, entryOverrides),
		scenario: {
			fixture: () => "ready",
			assertion: () => {
				throw EXPECTED_ASSERTION;
			},
		},
	};
}

function resolvedCase(ac: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ac,
		fullTestName: `Line 13 expected failure for ${ac}`,
		scenario: {
			fixture: () => "ready",
			assertion: () => undefined,
		},
		...overrides,
	};
}

function fixtureShards(
	completedShardIds: readonly string[] = LINE13_KNOWN_GAP_SHARD_IDS,
	resolvedAcceptanceCriteria: readonly string[] = [],
): Record<string, unknown>[] {
	const resolved = new Set(resolvedAcceptanceCriteria);
	return LINE13_KNOWN_GAP_SHARD_IDS.map((shardId, shardIndex) => ({
		schemaVersion: 1,
		shardId,
		complete: completedShardIds.includes(shardId),
		cases:
			completedShardIds.includes(shardId)
				? LINE13_AC_IDS.slice(shardIndex * 8, shardIndex * 8 + 8)
					.filter((ac) => !resolved.has(ac))
					.map((ac) => knownGapCase(ac))
				: [],
		resolvedCases: completedShardIds.includes(shardId)
			? LINE13_AC_IDS.slice(shardIndex * 8, shardIndex * 8 + 8)
				.filter((ac) => resolved.has(ac))
				.map((ac) => resolvedCase(ac))
			: [],
	})).reverse();
}

const PARTIAL_SHARD_COMPLETION_STATES = [
	{ label: "zero", shardIds: [] },
	{ label: "only 01-08", shardIds: ["ac-01-08"] },
	{ label: "only 09-16", shardIds: ["ac-09-16"] },
	{ label: "only 17-24", shardIds: ["ac-17-24"] },
	{ label: "01-16", shardIds: ["ac-01-08", "ac-09-16"] },
	{ label: "01-08 and 17-24", shardIds: ["ac-01-08", "ac-17-24"] },
	{ label: "09-24", shardIds: ["ac-09-16", "ac-17-24"] },
] as const;

function fakeTestApi(): CapturedTests {
	const normal: CapturedTest[] = [];
	const fails: CapturedTest[] = [];
	return {
		normal,
		fails,
		api: {
			normal: (name, body) => normal.push({ name, body }),
			fails: (name, body) => fails.push({ name, body }),
		},
	};
}

function registerScenario<TFixture>(
	scenario: Line13KnownGapScenario<TFixture>,
	entryOverrides: Record<string, unknown> = {},
): CapturedTests {
	const knownGap = defineLine13KnownGapCase({
		entry: knownGapEntry("AC-01", entryOverrides),
		scenario,
	});
	const shard = defineLine13KnownGapCaseShard({
		schemaVersion: 1,
		shardId: "ac-01-08",
		complete: true,
		cases: [
			knownGap,
			...LINE13_AC_IDS.slice(1, 8).map((ac) =>
				defineLine13KnownGapCase({
					entry: knownGapEntry(ac),
					scenario: {
						fixture: () => "ready",
						assertion: () => {
							throw EXPECTED_ASSERTION;
						},
					},
				}),
			),
		],
	});
	const captured = fakeTestApi();
	registerLine13KnownGapCaseWith(shard.cases[0]!, captured.api);
	return captured;
}

function registerResolvedScenario<TFixture>(scenario: Line13KnownGapScenario<TFixture>): CapturedTests {
	const resolved = defineLine13ResolvedCase({
		ac: "AC-01",
		fullTestName: "Line 13 expected failure for AC-01",
		scenario,
	});
	const shard = defineLine13KnownGapCaseShard({
		schemaVersion: 1,
		shardId: "ac-01-08",
		complete: true,
		cases: LINE13_AC_IDS.slice(1, 8).map((ac) =>
			defineLine13KnownGapCase({
				entry: knownGapEntry(ac),
				scenario: {
					fixture: () => "ready",
					assertion: () => {
						throw EXPECTED_ASSERTION;
					},
				},
			}),
		),
		resolvedCases: [resolved],
	});
	const captured = fakeTestApi();
	registerLine13ResolvedCaseWith(shard.resolvedCases[0]!, captured.api);
	return captured;
}

for (const knownGapCaseDefinition of LINE13_FINAL_KNOWN_GAP_CASES) {
	registerLine13KnownGapCase(knownGapCaseDefinition);
}

for (const resolvedCaseDefinition of LINE13_FINAL_RESOLVED_CASES) {
	registerLine13ResolvedCase(resolvedCaseDefinition);
}

test("defines every Line 13 acceptance criterion, owner stage, and exclusive shard", () => {
	expect(LINE13_AC_IDS).toEqual(Array.from({ length: 24 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`));
	expect(LINE13_OWNER_STAGES).toEqual([
		"T1a",
		"T1b",
		"T2",
		"T3a",
		"T3b",
		"T4",
		"T5",
		"T6",
		"T7",
		"T8",
		"T9a",
		"T9b",
		"T9c",
		"T10",
	]);
	expect(LINE13_KNOWN_GAP_SHARD_IDS).toEqual(["ac-01-08", "ac-09-16", "ac-17-24"]);
});

test("loads three completed shards as a globally complete manifest", () => {
	const manifest = loadLine13KnownGapManifest(fixtureShards());
	expect(manifest.entries.map((entry) => entry.ac)).toEqual(LINE13_AC_IDS);
	expect(manifest.baseSha).toBe(LINE13_T0_BASE_SHA);
	expect(Object.isFrozen(manifest)).toBe(true);
	expect(Object.isFrozen(manifest.cases)).toBe(true);
	expect(Object.isFrozen(manifest.entries)).toBe(true);
	expect(Object.isFrozen(manifest.entries[0])).toBe(true);
	expect(Object.isFrozen(manifest.entries[0]?.expectedFailure)).toBe(true);
});

test("transitions all 24 cases one by one without weakening complete-shard coverage", async () => {
	const originalNames = new Map(LINE13_AC_IDS.map((ac) => [ac, `Line 13 expected failure for ${ac}`]));

	for (let resolvedCount = 0; resolvedCount <= LINE13_AC_IDS.length; resolvedCount += 1) {
		const resolvedAcceptanceCriteria = LINE13_AC_IDS.slice(0, resolvedCount);
		const transition = loadLine13KnownGapTransition(
			fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, resolvedAcceptanceCriteria),
		);
		const outstandingEntries = transition.knownGapManifest.entries;
		const coveredAcceptanceCriteria = [
			...outstandingEntries.map((entry) => entry.ac),
			...transition.resolvedCases.map((resolved) => resolved.ac),
		].sort((left, right) => left.localeCompare(right));

		expect(coveredAcceptanceCriteria).toEqual(LINE13_AC_IDS);
		expect(outstandingEntries).toHaveLength(LINE13_AC_IDS.length - resolvedCount);
		expect(transition.resolvedCases).toHaveLength(resolvedCount);
		expect(outstandingEntries.map((entry) => entry.ac)).toEqual(LINE13_AC_IDS.slice(resolvedCount));

		const captured = fakeTestApi();
		for (const knownGapCaseDefinition of transition.knownGapManifest.cases) {
			registerLine13KnownGapCaseWith(knownGapCaseDefinition, captured.api);
		}
		for (const resolvedCaseDefinition of transition.resolvedCases) {
			registerLine13ResolvedCaseWith(resolvedCaseDefinition, captured.api);
			expect(resolvedCaseDefinition.fullTestName).toBe(originalNames.get(resolvedCaseDefinition.ac));
			expect(Object.keys(resolvedCaseDefinition).sort()).toEqual(["ac", "fullTestName", "scenario"]);
			for (const forbiddenKey of ["baseSha", "ownerStage", "mode", "reason", "fingerprint", "expectedFailure"]) {
				expect(forbiddenKey in resolvedCaseDefinition).toBe(false);
			}
		}

		const resolvedNames = transition.resolvedCases.map((resolved) => resolved.fullTestName);
		for (const name of resolvedNames) {
			expect(captured.fails.map((registeredTest) => registeredTest.name)).not.toContain(name);
			expect(captured.normal.filter((registeredTest) => registeredTest.name === name)).toHaveLength(1);
		}
		for (const registeredTest of captured.normal) {
			await expect(registeredTest.body()).resolves.toBeUndefined();
		}
	}
});

test("supports a final empty outstanding-gap manifest with all 24 ordinary regressions", async () => {
	const transition = loadLine13KnownGapTransition(fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, LINE13_AC_IDS));
	expect(transition.knownGapManifest.cases).toEqual([]);
	expect(transition.knownGapManifest.entries).toEqual([]);
	expect(transition.resolvedCases.map((resolved) => resolved.ac)).toEqual(LINE13_AC_IDS);

	const captured = fakeTestApi();
	for (const resolvedCaseDefinition of transition.resolvedCases) {
		registerLine13ResolvedCaseWith(resolvedCaseDefinition, captured.api);
	}
	expect(captured.normal.map((registeredTest) => registeredTest.name)).toEqual(
		LINE13_AC_IDS.map((ac) => `Line 13 expected failure for ${ac}`),
	);
	expect(captured.fails).toEqual([]);
	for (const registeredTest of captured.normal) {
		await expect(registeredTest.body()).resolves.toBeUndefined();
	}
});

test.each(PARTIAL_SHARD_COMPLETION_STATES)(
	"loads and registers the $label completed-shard state without requiring incomplete siblings",
	async ({ shardIds }) => {
		const manifest = loadLine13KnownGapManifest(fixtureShards(shardIds));
		const completedShardIds = new Set<string>(shardIds);
		const expectedAcceptanceCriteria = LINE13_KNOWN_GAP_SHARD_IDS.flatMap((shardId, shardIndex) =>
			completedShardIds.has(shardId) ? LINE13_AC_IDS.slice(shardIndex * 8, shardIndex * 8 + 8) : [],
		);
		expect(manifest.entries.map((entry) => entry.ac)).toEqual(expectedAcceptanceCriteria);

		const captured = fakeTestApi();
		for (const knownGapCaseDefinition of manifest.cases) {
			registerLine13KnownGapCaseWith(knownGapCaseDefinition, captured.api);
		}
		expect(captured.normal).toHaveLength(expectedAcceptanceCriteria.length * 2);
		expect(captured.fails).toHaveLength(expectedAcceptanceCriteria.length);
		for (const registeredTest of captured.normal) {
			await expect(registeredTest.body()).resolves.toBeUndefined();
		}
		for (const registeredTest of captured.fails) {
			await expect(registeredTest.body()).rejects.toBe(EXPECTED_ASSERTION);
		}
	},
);

test("loads the completed portion of the actual final manifest", () => {
	const manifest = loadLine13FinalKnownGapManifest();
	const transition = loadLine13FinalKnownGapTransition();
	const completedShardCases = LINE13_FINAL_KNOWN_GAP_CASE_SHARDS.filter((shard) => shard.complete).flatMap(
		(shard) => shard.cases,
	);
	const completedShardResolvedCases = LINE13_FINAL_KNOWN_GAP_CASE_SHARDS.filter((shard) => shard.complete).flatMap(
		(shard) => shard.resolvedCases,
	);
	expect(new Set(LINE13_FINAL_KNOWN_GAP_CASES)).toEqual(new Set(completedShardCases));
	expect(new Set(LINE13_FINAL_RESOLVED_CASES)).toEqual(new Set(completedShardResolvedCases));
	expect(LINE13_FINAL_KNOWN_GAP_CASES).toEqual(manifest.cases);
	expect(LINE13_FINAL_RESOLVED_CASES).toEqual(transition.resolvedCases);
	expect(LINE13_FINAL_KNOWN_GAP_CASES.some((definition) => definition.entry.ac === "AC-01")).toBe(false);
	expect(LINE13_FINAL_RESOLVED_CASES.map((definition) => definition.ac)).toContain("AC-01");
	expect(manifest.entries.map((entry) => entry.ac)).toEqual(
		LINE13_FINAL_KNOWN_GAP_CASES.map((knownGapCaseDefinition) => knownGapCaseDefinition.entry.ac),
	);
});

test("defaults resolved cases to empty without requiring concurrent shard edits", () => {
	const shard = defineLine13KnownGapCaseShard({
		schemaVersion: 1,
		shardId: "ac-01-08",
		complete: false,
		cases: [],
	});
	expect(shard.resolvedCases).toEqual([]);
	expect(Object.isFrozen(shard.resolvedCases)).toBe(true);
});

test("requires explicit boolean shard completion state", () => {
	const missingCompletionState = fixtureShards([]);
	const missingCompletionShard = missingCompletionState.find((shard) => shard.shardId === "ac-01-08");
	if (missingCompletionShard === undefined) throw new Error("fixture shard is missing");
	delete missingCompletionShard.complete;
	expect(() => loadLine13KnownGapManifest(missingCompletionState)).toThrow("shard.complete is required");

	const invalidCompletionState = fixtureShards([]);
	const invalidCompletionShard = invalidCompletionState.find((shard) => shard.shardId === "ac-01-08");
	if (invalidCompletionShard === undefined) throw new Error("fixture shard is missing");
	invalidCompletionShard.complete = "yes";
	expect(() => loadLine13KnownGapManifest(invalidCompletionState)).toThrow("shard.complete must be a boolean");
});

test("rejects incomplete shards carrying known-gap or resolved cases", () => {
	for (const field of ["cases", "resolvedCases"] as const) {
		for (const ac of ["AC-01", "AC-09"]) {
			const shards = fixtureShards([]);
			const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
			if (firstShard === undefined) throw new Error("fixture shard is missing");
			firstShard[field] = [field === "cases" ? knownGapCase(ac) : resolvedCase(ac)];
			expect(() => loadLine13KnownGapManifest(shards)).toThrow("incomplete shard ac-01-08 must be empty");
		}
	}
});

test("rejects missing shards and acceptance criteria", () => {
	const missingShard = fixtureShards().slice(1);
	expect(() => loadLine13KnownGapManifest(missingShard)).toThrow("missing shards");

	const incomplete = fixtureShards();
	const firstShard = incomplete.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	firstShard.cases = firstShard.cases.slice(1);
	expect(() => loadLine13KnownGapManifest(incomplete)).toThrow("missing AC-01");
});

test.each(["ac", "fullTestName", "baseSha", "ownerStage", "mode", "expectedFailure"])(
	"rejects a manifest entry missing %s",
	(key) => {
		const shards = fixtureShards();
		const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
		if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
		const firstCase = firstShard.cases[0] as Record<string, unknown>;
		const entry = firstCase.entry as Record<string, unknown>;
		delete entry[key];
		expect(() => loadLine13KnownGapManifest(shards)).toThrow(`${key} is required`);
	},
);

test.each([
	["invalid acceptance criterion", { ac: "AC-25" }, "AC-01 through AC-24"],
	["invalid full test name", { fullTestName: " Line 13 gap " }, "complete, trimmed, single-line"],
	["multi-line full test name", { fullTestName: "Line 13 gap\ncontinued" }, "complete, trimmed, single-line"],
	["invalid base SHA", { baseSha: "0000000000000000000000000000000000000000" }, "T0 base SHA"],
	["missing owner stage", { ownerStage: "" }, "repair stage"],
	["invalid owner stage", { ownerStage: "T0" }, "repair stage"],
	["skip mode", { mode: "skip" }, "skip and todo are forbidden"],
	["todo mode", { mode: "todo" }, "skip and todo are forbidden"],
] as const)("rejects %s", (_label, override, expectedMessage) => {
	const shards = fixtureShards();
	const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	const firstCase = firstShard.cases[0] as Record<string, unknown>;
	firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), ...override };
	expect(() => loadLine13KnownGapManifest(shards)).toThrow(expectedMessage);
});

test("rejects explicit skip or todo flags at the entry and case boundaries", () => {
	for (const extra of [{ skip: true }, { todo: true }]) {
		const shards = fixtureShards();
		const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
		if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
		const firstCase = firstShard.cases[0] as Record<string, unknown>;
		firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), ...extra };
		expect(() => loadLine13KnownGapManifest(shards)).toThrow("skip and todo are forbidden");

		const caseShards = fixtureShards();
		const caseShard = caseShards.find((shard) => shard.shardId === "ac-01-08");
		if (caseShard === undefined || !Array.isArray(caseShard.cases)) throw new Error("fixture shard is malformed");
		caseShard.cases[0] = { ...(caseShard.cases[0] as Record<string, unknown>), ...extra };
		expect(() => loadLine13KnownGapManifest(caseShards)).toThrow(`${Object.keys(extra)[0]} is not allowed`);
	}
});

test("rejects known-gap metadata and test modifiers on resolved cases", () => {
	for (const extra of [
		{ baseSha: LINE13_T0_BASE_SHA },
		{ ownerStage: "T3a" },
		{ mode: "fails" },
		{ reason: EXPECTED_REASON },
		{ fingerprint: EXPECTED_FINGERPRINT },
		{ expectedFailure: { reason: EXPECTED_REASON, fingerprint: EXPECTED_FINGERPRINT } },
		{ skip: true },
		{ todo: true },
	]) {
		const shards = fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, ["AC-01"]);
		const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
		if (firstShard === undefined || !Array.isArray(firstShard.resolvedCases)) {
			throw new Error("fixture shard is malformed");
		}
		firstShard.resolvedCases[0] = {
			...(firstShard.resolvedCases[0] as Record<string, unknown>),
			...extra,
		};
		expect(() => loadLine13KnownGapTransition(shards)).toThrow(`${Object.keys(extra)[0]} is not allowed`);
	}
});

test.each([
	["missing reason", { fingerprint: EXPECTED_FINGERPRINT }, "reason is required"],
	["missing fingerprint", { reason: EXPECTED_REASON }, "fingerprint is required"],
	[
		"invalid reason",
		{ reason: "The assertion changed", fingerprint: EXPECTED_FINGERPRINT },
		"stable lowercase reason code",
	],
	["invalid fingerprint", { reason: EXPECTED_REASON, fingerprint: "sha256:not-a-digest" }, "lowercase SHA-256"],
	["uppercase fingerprint", { reason: EXPECTED_REASON, fingerprint: `sha256:${"A".repeat(64)}` }, "lowercase SHA-256"],
	[
		"unexpected failure field",
		{ reason: EXPECTED_REASON, fingerprint: EXPECTED_FINGERPRINT, stack: "forbidden" },
		"stack is not allowed",
	],
] as const)("rejects an expected failure with %s", (_label, expectedFailure, expectedMessage) => {
	const shards = fixtureShards();
	const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	const firstCase = firstShard.cases[0] as Record<string, unknown>;
	firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), expectedFailure };
	expect(() => loadLine13KnownGapManifest(shards)).toThrow(expectedMessage);
});

test("rejects duplicate shard ids, acceptance criteria, and full test names", () => {
	const duplicateShard = fixtureShards();
	duplicateShard.push(duplicateShard[0]!);
	expect(() => loadLine13KnownGapManifest(duplicateShard)).toThrow("Duplicate Line 13 known-gap shard");

	const duplicateAcceptanceCriterion = fixtureShards();
	const firstShard = duplicateAcceptanceCriterion.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	firstShard.cases[1] = knownGapCase("AC-01", { fullTestName: "Line 13 duplicate AC" });
	expect(() => loadLine13KnownGapManifest(duplicateAcceptanceCriterion)).toThrow("duplicate acceptance criterion AC-01");

	const duplicateFullTestName = fixtureShards();
	const secondShard = duplicateFullTestName.find((shard) => shard.shardId === "ac-09-16");
	if (secondShard === undefined || !Array.isArray(secondShard.cases)) throw new Error("fixture shard is malformed");
	secondShard.cases[0] = knownGapCase("AC-09", { fullTestName: "Line 13 expected failure for AC-01" });
	expect(() => loadLine13KnownGapManifest(duplicateFullTestName)).toThrow(
		"Duplicate Line 13 known-gap full test name",
	);
});

test("rejects missing, duplicate, and overlapping coverage across known-gap and resolved states", () => {
	const missing = fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, ["AC-01"]);
	const missingShard = missing.find((shard) => shard.shardId === "ac-01-08");
	if (missingShard === undefined || !Array.isArray(missingShard.resolvedCases)) {
		throw new Error("fixture shard is malformed");
	}
	missingShard.resolvedCases = [];
	expect(() => loadLine13KnownGapTransition(missing)).toThrow("completed shard ac-01-08 is missing AC-01");

	const overlappingAcceptanceCriterion = fixtureShards();
	const overlapShard = overlappingAcceptanceCriterion.find((shard) => shard.shardId === "ac-01-08");
	if (overlapShard === undefined) throw new Error("fixture shard is missing");
	overlapShard.resolvedCases = [resolvedCase("AC-01")];
	expect(() => loadLine13KnownGapTransition(overlappingAcceptanceCriterion)).toThrow(
		"duplicate acceptance criterion AC-01 across known-gap and resolved cases",
	);

	const overlappingFullTestName = fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, ["AC-02"]);
	const fullNameShard = overlappingFullTestName.find((shard) => shard.shardId === "ac-01-08");
	if (fullNameShard === undefined || !Array.isArray(fullNameShard.resolvedCases)) {
		throw new Error("fixture shard is malformed");
	}
	fullNameShard.resolvedCases[0] = resolvedCase("AC-02", {
		fullTestName: "Line 13 expected failure for AC-01",
	});
	expect(() => loadLine13KnownGapTransition(overlappingFullTestName)).toThrow(
		"duplicate full test name Line 13 expected failure for AC-01 across known-gap and resolved cases",
	);

	const duplicateResolvedAcceptanceCriterion = fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, ["AC-01", "AC-02"]);
	const duplicateResolvedShard = duplicateResolvedAcceptanceCriterion.find((shard) => shard.shardId === "ac-01-08");
	if (duplicateResolvedShard === undefined || !Array.isArray(duplicateResolvedShard.resolvedCases)) {
		throw new Error("fixture shard is malformed");
	}
	duplicateResolvedShard.resolvedCases[1] = resolvedCase("AC-01", {
		fullTestName: "Line 13 duplicate resolved AC",
	});
	expect(() => loadLine13KnownGapTransition(duplicateResolvedAcceptanceCriterion)).toThrow(
		"duplicate acceptance criterion AC-01",
	);

	const duplicateResolvedFullTestName = fixtureShards(LINE13_KNOWN_GAP_SHARD_IDS, ["AC-01", "AC-02"]);
	const duplicateNameShard = duplicateResolvedFullTestName.find((shard) => shard.shardId === "ac-01-08");
	if (duplicateNameShard === undefined || !Array.isArray(duplicateNameShard.resolvedCases)) {
		throw new Error("fixture shard is malformed");
	}
	duplicateNameShard.resolvedCases[1] = resolvedCase("AC-02", {
		fullTestName: "Line 13 expected failure for AC-01",
	});
	expect(() => loadLine13KnownGapTransition(duplicateResolvedFullTestName)).toThrow(
		"duplicate full test name Line 13 expected failure for AC-01",
	);
});

test("rejects entries routed through another worker's shard", () => {
	const shards = fixtureShards();
	const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	firstShard.cases[0] = knownGapCase("AC-09");
	expect(() => loadLine13KnownGapManifest(shards)).toThrow("AC-09 does not belong to ac-01-08");
});

test("requires expected-failure registrations to use a case exported through a shard", () => {
	const knownGap = defineLine13KnownGapCase({
		entry: knownGapEntry("AC-01"),
		scenario: {
			fixture: () => "ready",
			assertion: () => {
				throw EXPECTED_ASSERTION;
			},
		},
	});
	expect(() => registerLine13KnownGapCaseWith(knownGap, fakeTestApi().api)).toThrow("exported through a manifest shard");
});

test("requires resolved registrations to use a case exported through a shard", () => {
	const resolved = defineLine13ResolvedCase({
		ac: "AC-01",
		fullTestName: "Line 13 expected failure for AC-01",
		scenario: {
			fixture: () => "ready",
			assertion: () => undefined,
		},
	});
	expect(() => registerLine13ResolvedCaseWith(resolved, fakeTestApi().api)).toThrow(
		"exported through a manifest shard",
	);
});

test("fingerprints only assertion failures without exposing assertion text", () => {
	const secretMessage = "expected secret-token-123 to be redacted";
	const fingerprint = fingerprintLine13Failure(EXPECTED_REASON, assertionFailure(secretMessage));
	expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(fingerprint).not.toContain(secretMessage);
	expect(() => fingerprintLine13Failure(EXPECTED_REASON, new Error("arbitrary transport failure"))).toThrow(
		"require an AssertionError",
	);
});

test("normalizes terminal formatting and workspace paths before fingerprinting", () => {
	const workspace = process.cwd();
	const windowsMessage = `\u001b[31m${workspace}\\fixture.ts\r\nexpected value\u001b[0m`;
	const portableMessage = `${workspace.replaceAll("\\", "/")}/fixture.ts\nexpected value`;
	expect(fingerprintLine13Failure(EXPECTED_REASON, assertionFailure(windowsMessage))).toBe(
		fingerprintLine13Failure(EXPECTED_REASON, assertionFailure(portableMessage)),
	);
});

test("rejects reason or assertion drift from the manifest fingerprint", async () => {
	const reasonDrift = registerScenario(
		{
			fixture: () => "ready",
			assertion: () => {
				throw EXPECTED_ASSERTION;
			},
		},
		{ expectedFailure: { reason: "connector.dispatch", fingerprint: EXPECTED_FINGERPRINT } },
	);
	await expect(reasonDrift.normal[1]?.body()).rejects.toThrow("fingerprint drift");

	const assertionDrift = registerScenario({
		fixture: () => "ready",
		assertion: () => {
			throw assertionFailure("the implementation now fails for another reason");
		},
	});
	await expect(assertionDrift.normal[1]?.body()).rejects.toThrow("fingerprint drift");
});

test("registers fixture health and fingerprint guards plus the tied fails marker", async () => {
	let setupCount = 0;
	let cleanupCount = 0;
	const captured = registerScenario({
		fixture: () => ({ ready: true }),
		setup: (fixture) => {
			expect(fixture.ready).toBe(true);
			setupCount += 1;
		},
		assertion: () => {
			throw EXPECTED_ASSERTION;
		},
		cleanup: () => {
			cleanupCount += 1;
		},
	});

	expect(captured.normal.map((entry) => entry.name)).toEqual([
		"[fixture health] AC-01 Line 13 expected failure for AC-01",
		"[known-gap fingerprint] AC-01 Line 13 expected failure for AC-01",
	]);
	expect(captured.fails.map((entry) => entry.name)).toEqual(["Line 13 expected failure for AC-01"]);
	await expect(captured.normal[0]?.body()).resolves.toBeUndefined();
	await expect(captured.normal[1]?.body()).resolves.toBeUndefined();
	await expect(captured.fails[0]?.body()).rejects.toBe(EXPECTED_ASSERTION);
	expect(setupCount).toBe(3);
	expect(cleanupCount).toBe(3);
});

test("rejects arbitrary fixture, setup, assertion, and cleanup errors", async () => {
	const failures = [
		{
			label: "fixture-error",
			scenario: {
				fixture: () => {
					throw new Error("fixture unavailable");
				},
				assertion: () => {
					throw EXPECTED_ASSERTION;
				},
			},
		},
		{
			label: "setup-error",
			scenario: {
				fixture: () => "ready",
				setup: () => {
					throw new Error("setup unavailable");
				},
				assertion: () => {
					throw EXPECTED_ASSERTION;
				},
			},
		},
		{
			label: "arbitrary-error",
			scenario: {
				fixture: () => "ready",
				assertion: () => {
					throw new Error("sensitive transport failure");
				},
			},
		},
		{
			label: "cleanup-error",
			scenario: {
				fixture: () => "ready",
				assertion: () => {
					throw EXPECTED_ASSERTION;
				},
				cleanup: () => {
					throw new Error("cleanup failed");
				},
			},
		},
	] as const;

	for (const { label, scenario } of failures) {
		const captured = registerScenario(scenario);
		await expect(captured.normal[1]?.body()).rejects.toThrow(`rejected ${label}`);
	}
});

test("rejects an unexpected pass and exposes it to Vitest fails semantics", async () => {
	const captured = registerScenario({
		fixture: () => "ready",
		assertion: () => undefined,
	});
	await expect(captured.normal[1]?.body()).rejects.toThrow("rejected unexpected-pass");
	await expect(captured.fails[0]?.body()).resolves.toBeUndefined();
});

test("registers resolved cases as one ordinary Vitest test with the preserved name", async () => {
	const captured = registerResolvedScenario({
		fixture: () => ({ ready: true }),
		setup: (fixture) => {
			expect(fixture.ready).toBe(true);
		},
		assertion: (fixture) => {
			expect(fixture.ready).toBe(true);
		},
		cleanup: (fixture) => {
			expect(fixture.ready).toBe(true);
		},
	});
	expect(captured.normal.map((registeredTest) => registeredTest.name)).toEqual([
		"Line 13 expected failure for AC-01",
	]);
	expect(captured.fails).toEqual([]);
	await expect(captured.normal[0]?.body()).resolves.toBeUndefined();
});

test("fails resolved cases on assertion failures and arbitrary errors", async () => {
	for (const failure of [assertionFailure("resolved assertion failed"), new Error("arbitrary transport failure")]) {
		const captured = registerResolvedScenario({
			fixture: () => "ready",
			assertion: () => {
				throw failure;
			},
		});
		expect(captured.fails).toEqual([]);
		await expect(captured.normal[0]?.body()).rejects.toBe(failure);
	}
});
