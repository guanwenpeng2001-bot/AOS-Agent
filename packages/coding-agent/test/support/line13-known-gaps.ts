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

export interface Line13KnownGap {
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

export interface Line13KnownGapRegistry {
	register(entry: unknown): Line13KnownGap;
	snapshot(): readonly Line13KnownGap[];
	assertComplete(): readonly Line13KnownGap[];
}

export interface Line13KnownGapScenario<TFixture> {
	fixture: () => TFixture | Promise<TFixture>;
	assertion: (fixture: TFixture) => void | Promise<void>;
	cleanup?: (fixture: TFixture) => void | Promise<void>;
}

export interface Line13ExpectedFailureTestApi {
	normal(name: string, body: () => void | Promise<void>): void;
	fails(name: string, body: () => void | Promise<void>): void;
}

export type RegisterLine13KnownGap = <TFixture>(
	entry: unknown,
	scenario: Line13KnownGapScenario<TFixture>,
) => Line13KnownGap;

type AssertionFailureRecord = Record<string, unknown> & {
	name: "AssertionError";
	message: string;
};

type ScenarioOutcome =
	| { kind: "expected-assertion"; failure: AssertionFailureRecord }
	| { kind: "unexpected-pass" }
	| { kind: "fixture-error" }
	| { kind: "cleanup-error" }
	| { kind: "arbitrary-error" };

const AC_ID_SET = new Set<string>(LINE13_AC_IDS);
const OWNER_STAGE_SET = new Set<string>(LINE13_OWNER_STAGES);
const FAILURE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FAILURE_REASON_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function invalidEntry(problem: string): never {
	throw new Error(`Invalid Line 13 known-gap entry: ${problem}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalidEntry(`${context} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[], context: string): void {
	for (const key of expectedKeys) {
		if (!Object.hasOwn(record, key)) {
			invalidEntry(`${context}.${key} is required`);
		}
	}
	const expected = new Set(expectedKeys);
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) {
			invalidEntry(`${context}.${key} is not allowed`);
		}
	}
}

function validateFailureReason(reason: unknown): string {
	if (typeof reason !== "string" || reason.length > 80 || !FAILURE_REASON_PATTERN.test(reason)) {
		return invalidEntry("expectedFailure.reason must be a stable lowercase reason code");
	}
	return reason;
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

export function validateLine13KnownGap(value: unknown): Line13KnownGap {
	const entry = asRecord(value, "entry");
	if (Object.hasOwn(entry, "skip") || Object.hasOwn(entry, "todo")) {
		return invalidEntry('skip and todo are forbidden; use mode "fails"');
	}
	assertExactKeys(entry, ["ac", "fullTestName", "baseSha", "ownerStage", "mode", "expectedFailure"], "entry");

	if (typeof entry.ac !== "string" || !AC_ID_SET.has(entry.ac)) {
		return invalidEntry("entry.ac must be AC-01 through AC-24");
	}
	if (
		typeof entry.fullTestName !== "string" ||
		entry.fullTestName.length === 0 ||
		entry.fullTestName.length > 300 ||
		entry.fullTestName.trim() !== entry.fullTestName ||
		CONTROL_CHARACTER_PATTERN.test(entry.fullTestName)
	) {
		return invalidEntry("entry.fullTestName must be a complete, trimmed, single-line test name");
	}
	if (entry.baseSha !== LINE13_T0_BASE_SHA) {
		return invalidEntry("entry.baseSha must match the Line 13 T0 base SHA");
	}
	if (typeof entry.ownerStage !== "string" || !OWNER_STAGE_SET.has(entry.ownerStage)) {
		return invalidEntry("entry.ownerStage must name a Line 13 repair stage");
	}
	if (entry.mode !== "fails") {
		return invalidEntry('entry.mode must be "fails"; skip and todo are forbidden');
	}

	const expectedFailure = asRecord(entry.expectedFailure, "entry.expectedFailure");
	assertExactKeys(expectedFailure, ["reason", "fingerprint"], "entry.expectedFailure");
	const reason = validateFailureReason(expectedFailure.reason);
	if (
		typeof expectedFailure.fingerprint !== "string" ||
		!FAILURE_FINGERPRINT_PATTERN.test(expectedFailure.fingerprint)
	) {
		return invalidEntry("entry.expectedFailure.fingerprint must be a lowercase SHA-256 fingerprint");
	}

	return Object.freeze({
		ac: entry.ac as Line13AcceptanceCriterion,
		fullTestName: entry.fullTestName,
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: entry.ownerStage as Line13OwnerStage,
		mode: "fails",
		expectedFailure: Object.freeze({
			reason,
			fingerprint: expectedFailure.fingerprint as Line13FailureFingerprint,
		}),
	});
}

export function createLine13KnownGapRegistry(initialEntries: readonly unknown[] = []): Line13KnownGapRegistry {
	const entries: Line13KnownGap[] = [];
	const acceptanceCriteria = new Set<Line13AcceptanceCriterion>();
	const fullTestNames = new Set<string>();

	function register(entry: unknown): Line13KnownGap {
		const validated = validateLine13KnownGap(entry);
		if (acceptanceCriteria.has(validated.ac)) {
			throw new Error(`Duplicate Line 13 known-gap acceptance criterion: ${validated.ac}`);
		}
		if (fullTestNames.has(validated.fullTestName)) {
			throw new Error(`Duplicate Line 13 known-gap full test name: ${validated.fullTestName}`);
		}
		entries.push(validated);
		acceptanceCriteria.add(validated.ac);
		fullTestNames.add(validated.fullTestName);
		return validated;
	}

	function snapshot(): readonly Line13KnownGap[] {
		return Object.freeze([...entries].sort((left, right) => left.ac.localeCompare(right.ac)));
	}

	function assertComplete(): readonly Line13KnownGap[] {
		const missing = LINE13_AC_IDS.filter((ac) => !acceptanceCriteria.has(ac));
		if (missing.length > 0) {
			throw new Error(`Incomplete Line 13 known-gap manifest; missing ${missing.join(", ")}`);
		}
		return snapshot();
	}

	const registry = { register, snapshot, assertComplete };
	for (const entry of initialEntries) {
		registry.register(entry);
	}
	return registry;
}

async function runScenario<TFixture>(scenario: Line13KnownGapScenario<TFixture>): Promise<ScenarioOutcome> {
	let fixture: TFixture;
	try {
		fixture = await scenario.fixture();
	} catch {
		return { kind: "fixture-error" };
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

	if (passed) {
		return { kind: "unexpected-pass" };
	}
	if (!isAssertionFailure(failure)) {
		return { kind: "arbitrary-error" };
	}
	return { kind: "expected-assertion", failure };
}

async function runRawScenario<TFixture>(scenario: Line13KnownGapScenario<TFixture>): Promise<void> {
	const fixture = await scenario.fixture();
	try {
		await scenario.assertion(fixture);
	} finally {
		await scenario.cleanup?.(fixture);
	}
}

export function createLine13KnownGapRegistrar(
	registry: Line13KnownGapRegistry,
	testApi: Line13ExpectedFailureTestApi,
): RegisterLine13KnownGap {
	function register<TFixture>(entry: unknown, scenario: Line13KnownGapScenario<TFixture>): Line13KnownGap {
		const knownGap = registry.register(entry);

		testApi.normal(`[fixture health] ${knownGap.ac} ${knownGap.fullTestName}`, async () => {
			const fixture = await scenario.fixture();
			await scenario.cleanup?.(fixture);
		});

		testApi.normal(`[known-gap fingerprint] ${knownGap.ac} ${knownGap.fullTestName}`, async () => {
			const outcome = await runScenario(scenario);
			if (outcome.kind !== "expected-assertion") {
				throw new Error(`Line 13 known-gap ${knownGap.ac} rejected ${outcome.kind}`);
			}
			const observed = fingerprintLine13Failure(knownGap.expectedFailure.reason, outcome.failure);
			if (observed !== knownGap.expectedFailure.fingerprint) {
				throw new Error(
					`Line 13 known-gap ${knownGap.ac} fingerprint drift: expected ${knownGap.expectedFailure.fingerprint}, observed ${observed}`,
				);
			}
		});

		testApi.fails(knownGap.fullTestName, async () => {
			await runRawScenario(scenario);
		});
		return knownGap;
	}

	return register;
}

export const line13KnownGapRegistry = createLine13KnownGapRegistry();

const vitestApi: Line13ExpectedFailureTestApi = {
	normal: (name, body) => test(name, body),
	fails: (name, body) => test.fails(name, body),
};

export const registerLine13KnownGap = createLine13KnownGapRegistrar(line13KnownGapRegistry, vitestApi);
