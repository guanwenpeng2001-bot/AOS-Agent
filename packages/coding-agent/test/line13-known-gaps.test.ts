import { expect, test } from "vitest";
import {
	LINE13_FINAL_KNOWN_GAP_CASES,
	loadLine13FinalKnownGapManifest,
} from "./support/line13-final-known-gap-manifest.ts";
import {
	defineLine13KnownGapCase,
	defineLine13KnownGapCaseShard,
	fingerprintLine13Failure,
	LINE13_AC_IDS,
	LINE13_KNOWN_GAP_SHARD_IDS,
	LINE13_OWNER_STAGES,
	LINE13_T0_BASE_SHA,
	loadLine13KnownGapManifest,
	registerLine13KnownGapCase,
	registerLine13KnownGapCaseWith,
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

function completeFixtureShards(): Record<string, unknown>[] {
	return LINE13_KNOWN_GAP_SHARD_IDS.map((shardId, shardIndex) => ({
		schemaVersion: 1,
		shardId,
		cases: LINE13_AC_IDS.slice(shardIndex * 8, shardIndex * 8 + 8).map((ac) => knownGapCase(ac)),
	})).reverse();
}

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
	const shard = defineLine13KnownGapCaseShard({ schemaVersion: 1, shardId: "ac-01-08", cases: [knownGap] });
	const captured = fakeTestApi();
	registerLine13KnownGapCaseWith(shard.cases[0]!, captured.api);
	return captured;
}

for (const knownGapCaseDefinition of LINE13_FINAL_KNOWN_GAP_CASES) {
	registerLine13KnownGapCase(knownGapCaseDefinition);
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

test("loads a complete explicit cross-file fixture manifest deterministically", () => {
	const manifest = loadLine13KnownGapManifest(completeFixtureShards());
	expect(manifest.entries.map((entry) => entry.ac)).toEqual(LINE13_AC_IDS);
	expect(manifest.baseSha).toBe(LINE13_T0_BASE_SHA);
	expect(Object.isFrozen(manifest)).toBe(true);
	expect(Object.isFrozen(manifest.cases)).toBe(true);
	expect(Object.isFrozen(manifest.entries)).toBe(true);
	expect(Object.isFrozen(manifest.entries[0])).toBe(true);
	expect(Object.isFrozen(manifest.entries[0]?.expectedFailure)).toBe(true);
});

test("loads the actual final manifest as soon as shard population begins", () => {
	if (LINE13_FINAL_KNOWN_GAP_CASES.length === 0) {
		expect(loadLine13FinalKnownGapManifest).toThrow("missing AC-01");
		return;
	}
	const manifest = loadLine13FinalKnownGapManifest();
	expect(manifest.entries.map((entry) => entry.ac)).toEqual(LINE13_AC_IDS);
});

test("rejects missing shards and acceptance criteria", () => {
	const missingShard = completeFixtureShards().slice(1);
	expect(() => loadLine13KnownGapManifest(missingShard)).toThrow("missing shards");

	const incomplete = completeFixtureShards();
	const firstShard = incomplete.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	firstShard.cases = firstShard.cases.slice(1);
	expect(() => loadLine13KnownGapManifest(incomplete)).toThrow("missing AC-01");
});

test.each(["ac", "fullTestName", "baseSha", "ownerStage", "mode", "expectedFailure"])(
	"rejects a manifest entry missing %s",
	(key) => {
		const shards = completeFixtureShards();
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
	const shards = completeFixtureShards();
	const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	const firstCase = firstShard.cases[0] as Record<string, unknown>;
	firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), ...override };
	expect(() => loadLine13KnownGapManifest(shards)).toThrow(expectedMessage);
});

test("rejects explicit skip or todo flags at the entry and case boundaries", () => {
	for (const extra of [{ skip: true }, { todo: true }]) {
		const shards = completeFixtureShards();
		const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
		if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
		const firstCase = firstShard.cases[0] as Record<string, unknown>;
		firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), ...extra };
		expect(() => loadLine13KnownGapManifest(shards)).toThrow("skip and todo are forbidden");

		const caseShards = completeFixtureShards();
		const caseShard = caseShards.find((shard) => shard.shardId === "ac-01-08");
		if (caseShard === undefined || !Array.isArray(caseShard.cases)) throw new Error("fixture shard is malformed");
		caseShard.cases[0] = { ...(caseShard.cases[0] as Record<string, unknown>), ...extra };
		expect(() => loadLine13KnownGapManifest(caseShards)).toThrow(`${Object.keys(extra)[0]} is not allowed`);
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
	const shards = completeFixtureShards();
	const firstShard = shards.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	const firstCase = firstShard.cases[0] as Record<string, unknown>;
	firstCase.entry = { ...(firstCase.entry as Record<string, unknown>), expectedFailure };
	expect(() => loadLine13KnownGapManifest(shards)).toThrow(expectedMessage);
});

test("rejects duplicate shard ids, acceptance criteria, and full test names", () => {
	const duplicateShard = completeFixtureShards();
	duplicateShard.push(duplicateShard[0]!);
	expect(() => loadLine13KnownGapManifest(duplicateShard)).toThrow("Duplicate Line 13 known-gap shard");

	const duplicateAcceptanceCriterion = completeFixtureShards();
	const firstShard = duplicateAcceptanceCriterion.find((shard) => shard.shardId === "ac-01-08");
	if (firstShard === undefined || !Array.isArray(firstShard.cases)) throw new Error("fixture shard is malformed");
	firstShard.cases[1] = knownGapCase("AC-01", { fullTestName: "Line 13 duplicate AC" });
	expect(() => loadLine13KnownGapManifest(duplicateAcceptanceCriterion)).toThrow("duplicate acceptance criterion AC-01");

	const duplicateFullTestName = completeFixtureShards();
	const secondShard = duplicateFullTestName.find((shard) => shard.shardId === "ac-09-16");
	if (secondShard === undefined || !Array.isArray(secondShard.cases)) throw new Error("fixture shard is malformed");
	secondShard.cases[0] = knownGapCase("AC-09", { fullTestName: "Line 13 expected failure for AC-01" });
	expect(() => loadLine13KnownGapManifest(duplicateFullTestName)).toThrow(
		"Duplicate Line 13 known-gap full test name",
	);
});

test("rejects entries routed through another worker's shard", () => {
	const shards = completeFixtureShards();
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
