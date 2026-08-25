import { expect, test } from "vitest";
import {
	createLine13KnownGapRegistrar,
	createLine13KnownGapRegistry,
	fingerprintLine13Failure,
	LINE13_AC_IDS,
	LINE13_OWNER_STAGES,
	LINE13_T0_BASE_SHA,
	type Line13ExpectedFailureTestApi,
	type Line13KnownGapScenario,
} from "./support/line13-known-gaps.ts";

interface CapturedTest {
	name: string;
	body: () => void | Promise<void>;
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

function knownGapEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ac: "AC-01",
		fullTestName: "Line 13 connector lifecycle persists before dispatch",
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

function fakeTestApi(): {
	api: Line13ExpectedFailureTestApi;
	normal: CapturedTest[];
	fails: CapturedTest[];
} {
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
	entry: Record<string, unknown> = knownGapEntry(),
): ReturnType<typeof fakeTestApi> {
	const captured = fakeTestApi();
	createLine13KnownGapRegistrar(createLine13KnownGapRegistry(), captured.api)(entry, scenario);
	return captured;
}

test("defines every Line 13 acceptance criterion and repair stage", () => {
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
});

test("registers immutable entries in acceptance-criterion order", () => {
	const registry = createLine13KnownGapRegistry([
		knownGapEntry({ ac: "AC-02", fullTestName: "Line 13 second gap" }),
		knownGapEntry(),
	]);
	const manifest = registry.snapshot();
	expect(manifest.map((entry) => entry.ac)).toEqual(["AC-01", "AC-02"]);
	expect(Object.isFrozen(manifest)).toBe(true);
	expect(Object.isFrozen(manifest[0])).toBe(true);
	expect(Object.isFrozen(manifest[0]?.expectedFailure)).toBe(true);
});

test.each(["ac", "fullTestName", "baseSha", "ownerStage", "mode", "expectedFailure"])(
	"rejects a manifest entry missing %s",
	(key) => {
		const entry = knownGapEntry();
		delete entry[key];
		expect(() => createLine13KnownGapRegistry([entry])).toThrow(`${key} is required`);
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
	expect(() => createLine13KnownGapRegistry([knownGapEntry(override)])).toThrow(expectedMessage);
});

test("rejects explicit skip or todo flags and unexpected manifest fields", () => {
	expect(() => createLine13KnownGapRegistry([knownGapEntry({ skip: true })])).toThrow("skip and todo are forbidden");
	expect(() => createLine13KnownGapRegistry([knownGapEntry({ todo: true })])).toThrow("skip and todo are forbidden");
	expect(() => createLine13KnownGapRegistry([knownGapEntry({ retries: 3 })])).toThrow("retries is not allowed");
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
	expect(() => createLine13KnownGapRegistry([knownGapEntry({ expectedFailure })])).toThrow(expectedMessage);
});

test("rejects duplicate acceptance criteria and complete test names", () => {
	const duplicateAcceptanceCriterion = createLine13KnownGapRegistry();
	duplicateAcceptanceCriterion.register(knownGapEntry());
	expect(() =>
		duplicateAcceptanceCriterion.register(knownGapEntry({ fullTestName: "Line 13 connector lifecycle duplicate" })),
	).toThrow("Duplicate Line 13 known-gap acceptance criterion: AC-01");

	const duplicateFullTestName = createLine13KnownGapRegistry();
	duplicateFullTestName.register(knownGapEntry());
	expect(() => duplicateFullTestName.register(knownGapEntry({ ac: "AC-02" }))).toThrow(
		"Duplicate Line 13 known-gap full test name",
	);
});

test("accepts independently registered AC-01 through AC-24 and detects incomplete manifests", () => {
	const registry = createLine13KnownGapRegistry();
	expect(() => registry.assertComplete()).toThrow("missing AC-01");
	for (const ac of LINE13_AC_IDS) {
		registry.register(knownGapEntry({ ac, fullTestName: `Line 13 expected failure for ${ac}` }));
	}
	expect(registry.assertComplete().map((entry) => entry.ac)).toEqual(LINE13_AC_IDS);
});

test("fingerprints only assertion failures without exposing the assertion text", () => {
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

test("changes the fingerprint when the assertion reason or message drifts", () => {
	expect(fingerprintLine13Failure("connector.dispatch", EXPECTED_ASSERTION)).not.toBe(EXPECTED_FINGERPRINT);
	expect(fingerprintLine13Failure(EXPECTED_REASON, assertionFailure("expected a different lifecycle state"))).not.toBe(
		EXPECTED_FINGERPRINT,
	);
});

test("registers fixture health and fingerprint checks as normal tests and the gap with Vitest fails semantics", async () => {
	let cleanupCount = 0;
	const captured = registerScenario({
		fixture: () => ({ ready: true }),
		assertion: () => {
			throw EXPECTED_ASSERTION;
		},
		cleanup: () => {
			cleanupCount += 1;
		},
	});

	expect(captured.normal.map((entry) => entry.name)).toEqual([
		"[fixture health] AC-01 Line 13 connector lifecycle persists before dispatch",
		"[known-gap fingerprint] AC-01 Line 13 connector lifecycle persists before dispatch",
	]);
	expect(captured.fails.map((entry) => entry.name)).toEqual(["Line 13 connector lifecycle persists before dispatch"]);
	await expect(captured.normal[0]?.body()).resolves.toBeUndefined();
	await expect(captured.normal[1]?.body()).resolves.toBeUndefined();
	await expect(captured.fails[0]?.body()).rejects.toBe(EXPECTED_ASSERTION);
	expect(cleanupCount).toBe(3);
});

test("rejects arbitrary errors even though the fails-marked test also rejects", async () => {
	const captured = registerScenario({
		fixture: () => "ready",
		assertion: () => {
			throw new Error("sensitive transport failure");
		},
	});
	await expect(captured.normal[0]?.body()).resolves.toBeUndefined();
	await expect(captured.normal[1]?.body()).rejects.toThrow("rejected arbitrary-error");
	await expect(captured.normal[1]?.body()).rejects.not.toThrow("sensitive transport failure");
	await expect(captured.fails[0]?.body()).rejects.toThrow("sensitive transport failure");
});

test("rejects assertion fingerprint drift", async () => {
	const captured = registerScenario({
		fixture: () => "ready",
		assertion: () => {
			throw assertionFailure("the implementation now fails for another reason");
		},
	});
	await expect(captured.normal[1]?.body()).rejects.toThrow("fingerprint drift");
});

test("rejects an unexpected pass instead of allowing the known gap to linger", async () => {
	const captured = registerScenario({
		fixture: () => "ready",
		assertion: () => undefined,
	});
	await expect(captured.normal[1]?.body()).rejects.toThrow("rejected unexpected-pass");
	await expect(captured.fails[0]?.body()).resolves.toBeUndefined();
});

test("keeps fixture and cleanup health on the normal-test path", async () => {
	const fixtureFailure = registerScenario({
		fixture: () => {
			throw new Error("fixture unavailable");
		},
		assertion: () => {
			throw EXPECTED_ASSERTION;
		},
	});
	await expect(fixtureFailure.normal[0]?.body()).rejects.toThrow("fixture unavailable");
	await expect(fixtureFailure.normal[1]?.body()).rejects.toThrow("rejected fixture-error");

	const cleanupFailure = registerScenario(
		{
			fixture: () => "ready",
			assertion: () => {
				throw EXPECTED_ASSERTION;
			},
			cleanup: () => {
				throw new Error("cleanup failed");
			},
		},
		knownGapEntry({ ac: "AC-02", fullTestName: "Line 13 cleanup remains healthy" }),
	);
	await expect(cleanupFailure.normal[0]?.body()).rejects.toThrow("cleanup failed");
	await expect(cleanupFailure.normal[1]?.body()).rejects.toThrow("rejected cleanup-error");
});
