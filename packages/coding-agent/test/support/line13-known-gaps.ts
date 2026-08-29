import { createHash } from "node:crypto";
import { test } from "vitest";

export const LINE13_T0_BASE_SHA = "db279303b9e894b58acea165ab44f74bfdf0cddb" as const;

export const LINE13_AC_IDS = [
	"AC-01",
	"AC-02",
	"AC-03",
	"AC-04",
	"AC-05",
	"AC-06",
	"AC-07",
	"AC-08",
	"AC-09",
	"AC-10",
	"AC-11",
	"AC-12",
	"AC-13",
	"AC-14",
	"AC-15",
	"AC-16",
	"AC-17",
	"AC-18",
	"AC-19",
	"AC-20",
	"AC-21",
	"AC-22",
	"AC-23",
	"AC-24",
] as const;

export type Line13AcceptanceCriterion = (typeof LINE13_AC_IDS)[number];

export const LINE13_OWNER_STAGES = [
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
] as const;

export type Line13OwnerStage = (typeof LINE13_OWNER_STAGES)[number];
export type Line13FailureFingerprint = `sha256:${string}`;

export const LINE13_KNOWN_GAP_SHARD_IDS = ["ac-01-08", "ac-09-16", "ac-17-24"] as const;
export type Line13KnownGapShardId = (typeof LINE13_KNOWN_GAP_SHARD_IDS)[number];

const LINE13_SHARD_AC_IDS = {
	"ac-01-08": LINE13_AC_IDS.slice(0, 8),
	"ac-09-16": LINE13_AC_IDS.slice(8, 16),
	"ac-17-24": LINE13_AC_IDS.slice(16, 24),
} as const satisfies Record<Line13KnownGapShardId, readonly Line13AcceptanceCriterion[]>;

declare const line13KnownGapEntryBrand: unique symbol;
declare const line13KnownGapCaseBrand: unique symbol;
declare const line13ResolvedCaseBrand: unique symbol;

export interface Line13KnownGapEntry {
	readonly [line13KnownGapEntryBrand]: true;
	readonly ac: Line13AcceptanceCriterion;
	readonly fullTestName: string;
	readonly baseSha: typeof LINE13_T0_BASE_SHA;
	readonly ownerStage: Line13OwnerStage;
	readonly mode: "fails";
	readonly expectedFailure: {
		readonly reason: string;
		readonly fingerprint: Line13FailureFingerprint;
	};
}

export interface Line13KnownGapScenario<TFixture> {
	readonly fixture: () => TFixture | Promise<TFixture>;
	readonly setup?: (fixture: TFixture) => void | Promise<void>;
	readonly assertion: (fixture: TFixture) => void | Promise<void>;
	readonly cleanup?: (fixture: TFixture) => void | Promise<void>;
}

export interface Line13KnownGapCase {
	readonly [line13KnownGapCaseBrand]: true;
	readonly entry: Line13KnownGapEntry;
	readonly scenario: Line13KnownGapScenario<unknown>;
}

export interface Line13ResolvedCase {
	readonly [line13ResolvedCaseBrand]: true;
	readonly ac: Line13AcceptanceCriterion;
	readonly fullTestName: string;
	readonly timeoutMs?: number;
	readonly scenario: Line13KnownGapScenario<unknown>;
}

export interface Line13KnownGapCaseShard {
	readonly schemaVersion: 1;
	readonly shardId: Line13KnownGapShardId;
	readonly complete: boolean;
	readonly cases: readonly Line13KnownGapCase[];
	readonly resolvedCases: readonly Line13ResolvedCase[];
}

export interface Line13KnownGapManifest {
	readonly schemaVersion: 1;
	readonly baseSha: typeof LINE13_T0_BASE_SHA;
	readonly cases: readonly Line13KnownGapCase[];
	readonly entries: readonly Line13KnownGapEntry[];
}

export interface Line13KnownGapTransition {
	readonly knownGapManifest: Line13KnownGapManifest;
	readonly resolvedCases: readonly Line13ResolvedCase[];
}

export interface Line13ExpectedFailureTestApi {
	normal(name: string, body: () => void | Promise<void>, timeoutMs?: number): void;
	fails(name: string, body: () => void | Promise<void>): void;
}

type AssertionFailureRecord = Record<string, unknown> & {
	name: "AssertionError";
	message: string;
};

type ScenarioOutcome =
	| { kind: "expected-assertion"; failure: AssertionFailureRecord }
	| { kind: "unexpected-pass" }
	| { kind: "fixture-error" }
	| { kind: "setup-error" }
	| { kind: "cleanup-error" }
	| { kind: "arbitrary-error" };

const AC_ID_SET = new Set<string>(LINE13_AC_IDS);
const OWNER_STAGE_SET = new Set<string>(LINE13_OWNER_STAGES);
const SHARD_ID_SET = new Set<string>(LINE13_KNOWN_GAP_SHARD_IDS);
const FAILURE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FAILURE_REASON_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MANIFEST_CASE_MARKER = Symbol("line13-known-gap-manifest-case");
const RESOLVED_CASE_MARKER = Symbol("line13-resolved-manifest-case");

function invalidEntry(problem: string): never {
	throw new Error(`Invalid Line 13 known-gap entry: ${problem}`);
}

function invalidCase(problem: string): never {
	throw new Error(`Invalid Line 13 known-gap case: ${problem}`);
}

function invalidResolvedCase(problem: string): never {
	throw new Error(`Invalid Line 13 resolved case: ${problem}`);
}

function invalidShard(problem: string): never {
	throw new Error(`Invalid Line 13 known-gap shard: ${problem}`);
}

function asRecord(value: unknown, context: string, fail: (problem: string) => never): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fail(`${context} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(
	record: Record<string, unknown>,
	requiredKeys: readonly string[],
	context: string,
	fail: (problem: string) => never,
	optionalKeys: readonly string[] = [],
): void {
	for (const key of requiredKeys) {
		if (!Object.hasOwn(record, key)) {
			fail(`${context}.${key} is required`);
		}
	}
	const expected = new Set([...requiredKeys, ...optionalKeys]);
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) {
			fail(`${context}.${key} is not allowed`);
		}
	}
}

function validateFailureReason(reason: unknown): string {
	if (typeof reason !== "string" || reason.length > 80 || !FAILURE_REASON_PATTERN.test(reason)) {
		return invalidEntry("entry.expectedFailure.reason must be a stable lowercase reason code");
	}
	return reason;
}

function validateAcceptanceCriterion(
	ac: unknown,
	fail: (problem: string) => never,
): Line13AcceptanceCriterion {
	if (typeof ac !== "string" || !AC_ID_SET.has(ac)) {
		return fail("ac must be AC-01 through AC-24");
	}
	return ac as Line13AcceptanceCriterion;
}

function validateFullTestName(fullTestName: unknown, fail: (problem: string) => never): string {
	if (
		typeof fullTestName !== "string" ||
		fullTestName.length === 0 ||
		fullTestName.length > 300 ||
		fullTestName.trim() !== fullTestName ||
		CONTROL_CHARACTER_PATTERN.test(fullTestName)
	) {
		return fail("fullTestName must be a complete, trimmed, single-line test name");
	}
	return fullTestName;
}

function normalizeAssertionMessage(message: string): string {
	const normalizedSlashes = message
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\\", "/");
	const workspacePath = process.cwd().replaceAll("\\", "/");
	return normalizedSlashes.replaceAll(workspacePath, "<workspace>");
}

function isAssertionFailure(failure: unknown): failure is AssertionFailureRecord {
	if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
		return false;
	}
	const record = failure as Record<string, unknown>;
	if (record.name !== "AssertionError" || typeof record.message !== "string" || record.message.length === 0) {
		return false;
	}
	return (
		(Object.hasOwn(record, "actual") && Object.hasOwn(record, "expected")) ||
		typeof record.operator === "string" ||
		record.code === "ERR_ASSERTION"
	);
}

export function fingerprintLine13Failure(reason: string, failure: unknown): Line13FailureFingerprint {
	const validReason = validateFailureReason(reason);
	if (!isAssertionFailure(failure)) {
		throw new Error("Line 13 known-gap fingerprints require an AssertionError");
	}
	const code = typeof failure.code === "string" ? failure.code : null;
	const operator = typeof failure.operator === "string" ? failure.operator : null;
	const canonicalFailure = JSON.stringify({
		version: 1,
		reason: validReason,
		name: failure.name,
		message: normalizeAssertionMessage(failure.message),
		code,
		operator,
	});
	return `sha256:${createHash("sha256").update(canonicalFailure).digest("hex")}`;
}

export function defineLine13KnownGapEntry(value: unknown): Line13KnownGapEntry {
	const entry = asRecord(value, "entry", invalidEntry);
	if (Object.hasOwn(entry, "skip") || Object.hasOwn(entry, "todo")) {
		return invalidEntry('skip and todo are forbidden; use mode "fails"');
	}
	assertExactKeys(entry, ["ac", "fullTestName", "baseSha", "ownerStage", "mode", "expectedFailure"], "entry", invalidEntry);

	const ac = validateAcceptanceCriterion(entry.ac, (problem) => invalidEntry(`entry.${problem}`));
	const fullTestName = validateFullTestName(entry.fullTestName, (problem) => invalidEntry(`entry.${problem}`));
	if (entry.baseSha !== LINE13_T0_BASE_SHA) {
		return invalidEntry("entry.baseSha must match the Line 13 T0 base SHA");
	}
	if (typeof entry.ownerStage !== "string" || !OWNER_STAGE_SET.has(entry.ownerStage)) {
		return invalidEntry("entry.ownerStage must name a Line 13 repair stage");
	}
	if (entry.mode !== "fails") {
		return invalidEntry('entry.mode must be "fails"; skip and todo are forbidden');
	}

	const expectedFailure = asRecord(entry.expectedFailure, "entry.expectedFailure", invalidEntry);
	assertExactKeys(expectedFailure, ["reason", "fingerprint"], "entry.expectedFailure", invalidEntry);
	const reason = validateFailureReason(expectedFailure.reason);
	if (
		typeof expectedFailure.fingerprint !== "string" ||
		!FAILURE_FINGERPRINT_PATTERN.test(expectedFailure.fingerprint)
	) {
		return invalidEntry("entry.expectedFailure.fingerprint must be a lowercase SHA-256 fingerprint");
	}

	return Object.freeze({
		ac,
		fullTestName,
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: entry.ownerStage as Line13OwnerStage,
		mode: "fails",
		expectedFailure: Object.freeze({
			reason,
			fingerprint: expectedFailure.fingerprint as Line13FailureFingerprint,
		}),
	}) as Line13KnownGapEntry;
}

function validateLine13Scenario(
	value: unknown,
	fail: (problem: string) => never,
): Line13KnownGapScenario<unknown> {
	const scenario = asRecord(value, "scenario", fail);
	assertExactKeys(scenario, ["fixture", "assertion"], "scenario", fail, ["setup", "cleanup"]);
	if (typeof scenario.fixture !== "function") return fail("scenario.fixture must be a function");
	if (typeof scenario.assertion !== "function") return fail("scenario.assertion must be a function");
	if (scenario.setup !== undefined && typeof scenario.setup !== "function") {
		return fail("scenario.setup must be a function when provided");
	}
	if (scenario.cleanup !== undefined && typeof scenario.cleanup !== "function") {
		return fail("scenario.cleanup must be a function when provided");
	}
	return Object.freeze({
		fixture: scenario.fixture as () => unknown | Promise<unknown>,
		...(scenario.setup === undefined
			? {}
			: { setup: scenario.setup as (fixture: unknown) => void | Promise<void> }),
		assertion: scenario.assertion as (fixture: unknown) => void | Promise<void>,
		...(scenario.cleanup === undefined
			? {}
			: { cleanup: scenario.cleanup as (fixture: unknown) => void | Promise<void> }),
	});
}

export function defineLine13KnownGapCase<TFixture>(value: {
	readonly entry: unknown;
	readonly scenario: Line13KnownGapScenario<TFixture>;
}): Line13KnownGapCase {
	const knownGapCase = asRecord(value, "case", invalidCase);
	assertExactKeys(knownGapCase, ["entry", "scenario"], "case", invalidCase);
	return Object.freeze({
		entry: defineLine13KnownGapEntry(knownGapCase.entry),
		scenario: validateLine13Scenario(knownGapCase.scenario, invalidCase),
	}) as Line13KnownGapCase;
}

export function defineLine13ResolvedCase<TFixture>(value: {
	readonly ac: Line13AcceptanceCriterion;
	readonly fullTestName: string;
	readonly timeoutMs?: number;
	readonly scenario: Line13KnownGapScenario<TFixture>;
}): Line13ResolvedCase {
	const resolvedCase = asRecord(value, "case", invalidResolvedCase);
	assertExactKeys(resolvedCase, ["ac", "fullTestName", "scenario"], "case", invalidResolvedCase, ["timeoutMs"]);
	const timeoutMs = resolvedCase.timeoutMs;
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
	) {
		return invalidResolvedCase("case.timeoutMs must be a positive safe integer when provided");
	}
	return Object.freeze({
		ac: validateAcceptanceCriterion(resolvedCase.ac, (problem) => invalidResolvedCase(`case.${problem}`)),
		fullTestName: validateFullTestName(resolvedCase.fullTestName, (problem) => invalidResolvedCase(`case.${problem}`)),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		scenario: validateLine13Scenario(resolvedCase.scenario, invalidResolvedCase),
	}) as Line13ResolvedCase;
}

function assertCaseBelongsToShard(knownGapCase: Line13KnownGapCase, shardId: Line13KnownGapShardId): void {
	if (!LINE13_SHARD_AC_IDS[shardId].includes(knownGapCase.entry.ac)) {
		invalidShard(`entry ${knownGapCase.entry.ac} does not belong to ${shardId}`);
	}
}

function assertResolvedCaseBelongsToShard(resolvedCase: Line13ResolvedCase, shardId: Line13KnownGapShardId): void {
	if (!LINE13_SHARD_AC_IDS[shardId].includes(resolvedCase.ac)) {
		invalidShard(`resolved case ${resolvedCase.ac} does not belong to ${shardId}`);
	}
}

export function defineLine13KnownGapCaseShard(value: {
	readonly schemaVersion: 1;
	readonly shardId: Line13KnownGapShardId;
	readonly complete: boolean;
	readonly cases: readonly Line13KnownGapCase[];
	readonly resolvedCases?: readonly Line13ResolvedCase[];
}): Line13KnownGapCaseShard {
	const shard = asRecord(value, "shard", invalidShard);
	assertExactKeys(
		shard,
		["schemaVersion", "shardId", "complete", "cases"],
		"shard",
		invalidShard,
		["resolvedCases"],
	);
	if (shard.schemaVersion !== 1) return invalidShard("shard.schemaVersion must be 1");
	if (typeof shard.shardId !== "string" || !SHARD_ID_SET.has(shard.shardId)) {
		return invalidShard("shard.shardId must name a Line 13 AC range");
	}
	if (typeof shard.complete !== "boolean") return invalidShard("shard.complete must be a boolean");
	if (!Array.isArray(shard.cases)) return invalidShard("shard.cases must be an array");
	if (shard.resolvedCases !== undefined && !Array.isArray(shard.resolvedCases)) {
		return invalidShard("shard.resolvedCases must be an array when provided");
	}

	const shardId = shard.shardId as Line13KnownGapShardId;
	const unresolvedCases = shard.cases;
	const resolvedCaseValues = shard.resolvedCases ?? [];
	if (!shard.complete && (unresolvedCases.length > 0 || resolvedCaseValues.length > 0)) {
		return invalidShard(`incomplete shard ${shardId} must be empty`);
	}
	const acceptanceCriteria = new Set<Line13AcceptanceCriterion>();
	const fullTestNames = new Set<string>();
	const cases = unresolvedCases.map((item) => {
		const knownGapCase = defineLine13KnownGapCase(item as { entry: unknown; scenario: Line13KnownGapScenario<unknown> });
		assertCaseBelongsToShard(knownGapCase, shardId);
		if (acceptanceCriteria.has(knownGapCase.entry.ac)) {
			invalidShard(`duplicate acceptance criterion ${knownGapCase.entry.ac} in ${shardId}`);
		}
		if (fullTestNames.has(knownGapCase.entry.fullTestName)) {
			invalidShard(`duplicate full test name ${knownGapCase.entry.fullTestName} in ${shardId}`);
		}
		acceptanceCriteria.add(knownGapCase.entry.ac);
		fullTestNames.add(knownGapCase.entry.fullTestName);
		return Object.freeze({ ...knownGapCase, [MANIFEST_CASE_MARKER]: true }) as Line13KnownGapCase;
	});
	const resolvedCases = resolvedCaseValues.map((item) => {
		const resolvedCase = defineLine13ResolvedCase(item as {
			ac: Line13AcceptanceCriterion;
			fullTestName: string;
			scenario: Line13KnownGapScenario<unknown>;
		});
		assertResolvedCaseBelongsToShard(resolvedCase, shardId);
		if (acceptanceCriteria.has(resolvedCase.ac)) {
			invalidShard(`duplicate acceptance criterion ${resolvedCase.ac} across known-gap and resolved cases in ${shardId}`);
		}
		if (fullTestNames.has(resolvedCase.fullTestName)) {
			invalidShard(`duplicate full test name ${resolvedCase.fullTestName} across known-gap and resolved cases in ${shardId}`);
		}
		acceptanceCriteria.add(resolvedCase.ac);
		fullTestNames.add(resolvedCase.fullTestName);
		return Object.freeze({ ...resolvedCase, [RESOLVED_CASE_MARKER]: true }) as Line13ResolvedCase;
	});
	if (shard.complete) {
		const missingAcceptanceCriteria = LINE13_SHARD_AC_IDS[shardId].filter((ac) => !acceptanceCriteria.has(ac));
		if (missingAcceptanceCriteria.length > 0) {
			return invalidShard(
				`completed shard ${shardId} is missing ${missingAcceptanceCriteria.join(", ")}`,
			);
		}
	}
	return Object.freeze({
		schemaVersion: 1,
		shardId,
		complete: shard.complete,
		cases: Object.freeze(cases),
		resolvedCases: Object.freeze(resolvedCases),
	});
}

export function loadLine13KnownGapTransition(shards: readonly unknown[]): Line13KnownGapTransition {
	if (!Array.isArray(shards)) throw new Error("Invalid Line 13 known-gap manifest: shards must be an array");
	const shardIds = new Set<Line13KnownGapShardId>();
	const acceptanceCriteria = new Set<Line13AcceptanceCriterion>();
	const fullTestNames = new Set<string>();
	const cases: Line13KnownGapCase[] = [];
	const resolvedCases: Line13ResolvedCase[] = [];
	let completedShardCount = 0;

	for (const value of shards) {
		const shard = defineLine13KnownGapCaseShard(value as Line13KnownGapCaseShard);
		if (shardIds.has(shard.shardId)) {
			throw new Error(`Duplicate Line 13 known-gap shard: ${shard.shardId}`);
		}
		shardIds.add(shard.shardId);
		if (shard.complete) completedShardCount += 1;
		for (const knownGapCase of shard.cases) {
			const { entry } = knownGapCase;
			if (acceptanceCriteria.has(entry.ac)) {
				throw new Error(`Duplicate Line 13 known-gap acceptance criterion: ${entry.ac}`);
			}
			if (fullTestNames.has(entry.fullTestName)) {
				throw new Error(`Duplicate Line 13 known-gap full test name: ${entry.fullTestName}`);
			}
			acceptanceCriteria.add(entry.ac);
			fullTestNames.add(entry.fullTestName);
			cases.push(knownGapCase);
		}
		for (const resolvedCase of shard.resolvedCases) {
			if (acceptanceCriteria.has(resolvedCase.ac)) {
				throw new Error(
					`Duplicate Line 13 acceptance criterion across known-gap and resolved cases: ${resolvedCase.ac}`,
				);
			}
			if (fullTestNames.has(resolvedCase.fullTestName)) {
				throw new Error(
					`Duplicate Line 13 full test name across known-gap and resolved cases: ${resolvedCase.fullTestName}`,
				);
			}
			acceptanceCriteria.add(resolvedCase.ac);
			fullTestNames.add(resolvedCase.fullTestName);
			resolvedCases.push(resolvedCase);
		}
	}

	const missingShards = LINE13_KNOWN_GAP_SHARD_IDS.filter((shardId) => !shardIds.has(shardId));
	if (missingShards.length > 0) {
		throw new Error(`Incomplete Line 13 known-gap manifest; missing shards ${missingShards.join(", ")}`);
	}
	if (completedShardCount === LINE13_KNOWN_GAP_SHARD_IDS.length) {
		const missingAcceptanceCriteria = LINE13_AC_IDS.filter((ac) => !acceptanceCriteria.has(ac));
		if (cases.length + resolvedCases.length !== LINE13_AC_IDS.length || missingAcceptanceCriteria.length > 0) {
			throw new Error(`Incomplete Line 13 known-gap manifest; missing ${missingAcceptanceCriteria.join(", ")}`);
		}
	}

	cases.sort((left, right) => left.entry.ac.localeCompare(right.entry.ac));
	resolvedCases.sort((left, right) => left.ac.localeCompare(right.ac));
	const frozenCases = Object.freeze(cases);
	const knownGapManifest = Object.freeze({
		schemaVersion: 1 as const,
		baseSha: LINE13_T0_BASE_SHA,
		cases: frozenCases,
		entries: Object.freeze(frozenCases.map((knownGapCase) => knownGapCase.entry)),
	});
	return Object.freeze({
		knownGapManifest,
		resolvedCases: Object.freeze(resolvedCases),
	});
}

export function loadLine13KnownGapManifest(shards: readonly unknown[]): Line13KnownGapManifest {
	return loadLine13KnownGapTransition(shards).knownGapManifest;
}

async function runScenario<TFixture>(scenario: Line13KnownGapScenario<TFixture>): Promise<ScenarioOutcome> {
	let fixture: TFixture;
	try {
		fixture = await scenario.fixture();
	} catch {
		return { kind: "fixture-error" };
	}

	try {
		await scenario.setup?.(fixture);
	} catch {
		try {
			await scenario.cleanup?.(fixture);
		} catch {
			return { kind: "cleanup-error" };
		}
		return { kind: "setup-error" };
	}

	let failure: unknown;
	let passed = false;
	try {
		await scenario.assertion(fixture);
		passed = true;
	} catch (error) {
		failure = error;
	}

	try {
		await scenario.cleanup?.(fixture);
	} catch {
		return { kind: "cleanup-error" };
	}

	if (passed) return { kind: "unexpected-pass" };
	if (!isAssertionFailure(failure)) return { kind: "arbitrary-error" };
	return { kind: "expected-assertion", failure };
}

async function runFixtureHealth<TFixture>(scenario: Line13KnownGapScenario<TFixture>): Promise<void> {
	const fixture = await scenario.fixture();
	try {
		await scenario.setup?.(fixture);
	} finally {
		await scenario.cleanup?.(fixture);
	}
}

async function runRawScenario<TFixture>(scenario: Line13KnownGapScenario<TFixture>): Promise<void> {
	const fixture = await scenario.fixture();
	try {
		await scenario.setup?.(fixture);
		await scenario.assertion(fixture);
	} finally {
		await scenario.cleanup?.(fixture);
	}
}

export function registerLine13KnownGapCaseWith(
	knownGapCase: Line13KnownGapCase,
	testApi: Line13ExpectedFailureTestApi,
): void {
	if (!(MANIFEST_CASE_MARKER in knownGapCase)) {
		throw new Error("Line 13 known-gap registration requires a case exported through a manifest shard");
	}
	const { entry, scenario } = knownGapCase;

	testApi.normal(`[fixture health] ${entry.ac} ${entry.fullTestName}`, async () => {
		await runFixtureHealth(scenario);
	});

	testApi.normal(`[known-gap fingerprint] ${entry.ac} ${entry.fullTestName}`, async () => {
		const outcome = await runScenario(scenario);
		if (outcome.kind !== "expected-assertion") {
			throw new Error(`Line 13 known-gap ${entry.ac} rejected ${outcome.kind}`);
		}
		const observed = fingerprintLine13Failure(entry.expectedFailure.reason, outcome.failure);
		if (observed !== entry.expectedFailure.fingerprint) {
			throw new Error(
				`Line 13 known-gap ${entry.ac} fingerprint drift: expected ${entry.expectedFailure.fingerprint}, observed ${observed}`,
			);
		}
	});

	testApi.fails(entry.fullTestName, async () => {
		await runRawScenario(scenario);
	});
}

export function registerLine13ResolvedCaseWith(
	resolvedCase: Line13ResolvedCase,
	testApi: Line13ExpectedFailureTestApi,
): void {
	if (!(RESOLVED_CASE_MARKER in resolvedCase)) {
		throw new Error("Line 13 resolved registration requires a case exported through a manifest shard");
	}
	testApi.normal(resolvedCase.fullTestName, async () => {
		await runRawScenario(resolvedCase.scenario);
	}, resolvedCase.timeoutMs);
}

const vitestApi: Line13ExpectedFailureTestApi = {
	normal: (name, body, timeoutMs) => test(name, body, timeoutMs),
	fails: (name, body) => test.fails(name, body),
};

export function registerLine13KnownGapCase(knownGapCase: Line13KnownGapCase): void {
	registerLine13KnownGapCaseWith(knownGapCase, vitestApi);
}

export function registerLine13ResolvedCase(resolvedCase: Line13ResolvedCase): void {
	registerLine13ResolvedCaseWith(resolvedCase, vitestApi);
}
