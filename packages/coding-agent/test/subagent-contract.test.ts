import { describe, expect, it } from "vitest";
import * as subagentContract from "../src/core/subagent/lifecycle.ts";
import {
	CHILD_LIFECYCLE_STATUSES,
	SUBAGENT_FORBIDDEN_KEYS,
	childLifecycleTransitionAllowed,
	createChildAgentRecord,
	parseChildAgentRecord,
	serializeChildAgentRecord,
	transitionChildAgentRecord,
	validateChildAgentRecord,
	validateChildAgentTransition,
	type ChildAgentRecord,
	type ChildAgentTransition,
	type ChildLifecycleStatus,
	type CreateChildAgentRecordInput,
} from "../src/core/subagent/lifecycle.ts";

const BASE_TIME_MS = Date.parse("2026-08-22T00:00:00.000Z");
const creation: CreateChildAgentRecordInput = {
	schemaVersion: 1,
	childAgentInstanceId: "child-1",
	parentAgentInstanceId: "parent-1",
	ancestorIds: ["root-1", "parent-1"],
	depth: 2,
	spawnId: "spawn-1",
	taskId: "task-1",
	dispatchId: "dispatch-1",
	attemptId: "attempt-1",
	bindingId: "binding-1",
	bindingEpochIds: ["epoch-1"],
	providerKind: "in_process",
	providerId: "child-provider",
	forkScope: "none",
	createdAt: at(0),
};

function at(index: number): string {
	return new Date(BASE_TIME_MS + index * 1_000).toISOString();
}

function mustCreate(): ChildAgentRecord {
	const result = createChildAgentRecord(creation);
	if (!result.ok) throw result.error;
	return result.value;
}

function transition(
	record: ChildAgentRecord,
	to: ChildLifecycleStatus,
	index: number,
	overrides: Partial<ChildAgentTransition> = {},
): ChildAgentTransition {
	return {
		schemaVersion: 1,
		childAgentInstanceId: record.childAgentInstanceId,
		parentAgentInstanceId: record.parentAgentInstanceId,
		spawnId: record.spawnId,
		expectedRevision: record.revision,
		to,
		at: at(index),
		...(to === "succeeded" || to === "cancelled" ? { attemptReceiptId: `receipt-${to}` } : {}),
		...overrides,
	};
}

function mustTransition(
	record: ChildAgentRecord,
	to: ChildLifecycleStatus,
	index: number,
): ChildAgentRecord {
	const result = transitionChildAgentRecord(record, transition(record, to, index));
	if (!result.ok) throw result.error;
	return result.value.record;
}

const PATHS: Readonly<Record<ChildLifecycleStatus, readonly ChildLifecycleStatus[]>> = {
	spawning: [],
	running: ["running"],
	awaiting_input: ["running", "awaiting_input"],
	background: ["running", "background"],
	cancelling: ["running", "cancelling"],
	succeeded: ["running", "succeeded"],
	failed: ["failed"],
	cancelled: ["running", "cancelling", "cancelled"],
	lost: ["lost"],
	closed: ["running", "succeeded", "closed"],
};

function recordAt(status: ChildLifecycleStatus): ChildAgentRecord {
	let record = mustCreate();
	let index = 1;
	for (const next of PATHS[status]) record = mustTransition(record, next, index++);
	return record;
}

const LEGAL_EDGES = new Set([
	"spawning->running",
	"spawning->failed",
	"spawning->lost",
	"running->awaiting_input",
	"running->background",
	"running->cancelling",
	"running->succeeded",
	"running->failed",
	"running->lost",
	"awaiting_input->background",
	"awaiting_input->cancelling",
	"awaiting_input->failed",
	"awaiting_input->lost",
	"background->awaiting_input",
	"background->cancelling",
	"background->succeeded",
	"background->failed",
	"background->lost",
	"cancelling->failed",
	"cancelling->cancelled",
	"cancelling->lost",
	"succeeded->closed",
	"failed->closed",
	"cancelled->closed",
	"lost->closed",
]);

describe("line 12A Child Agent core contract", () => {
	it("accepts exactly the frozen lifecycle edges", () => {
		for (const from of CHILD_LIFECYCLE_STATUSES) {
			for (const to of CHILD_LIFECYCLE_STATUSES) {
				const record = recordAt(from);
				const result = transitionChildAgentRecord(record, transition(record, to, 20));
				const expected = LEGAL_EDGES.has(`${from}->${to}`);
				expect(childLifecycleTransitionAllowed(from, to), `${from}->${to}`).toBe(expected);
				const closeRetry = from === "closed" && to === "closed";
				expect(result.ok, `${from}->${to}`).toBe(expected || closeRetry);
				if (result.ok && expected) {
					expect(result.value.record.status).toBe(to);
					expect(result.value.record.revision).toBe(record.revision + 1);
				} else if (!result.ok) {
					expect(result.error.code).toBe("subagent_conflict");
				} else {
					expect(result.value).toMatchObject({ idempotent: true, record });
				}
			}
		}
	});

	it("rejects revision gaps, identity drift, and repeated execution terminals", () => {
		const running = recordAt("running");
		expect(
			transitionChildAgentRecord(running, transition(running, "succeeded", 5, { expectedRevision: 99 })),
		).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
		for (const drift of [
			{ childAgentInstanceId: "child-2" },
			{ parentAgentInstanceId: "parent-2" },
			{ spawnId: "spawn-2" },
		] satisfies ReadonlyArray<Partial<ChildAgentTransition>>) {
			expect(
				transitionChildAgentRecord(running, transition(running, "succeeded", 5, drift)),
			).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
		}
		const succeeded = mustTransition(running, "succeeded", 5);
		expect(
			transitionChildAgentRecord(succeeded, transition(succeeded, "failed", 6)),
		).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
	});

	it("makes close idempotent without rewriting the execution terminal", () => {
		const succeeded = recordAt("succeeded");
		const close = transition(succeeded, "closed", 5);
		const first = transitionChildAgentRecord(succeeded, close);
		expect(first).toMatchObject({ ok: true, value: { idempotent: false, record: { status: "closed" } } });
		if (!first.ok) return;
		expect(transitionChildAgentRecord(first.value.record, close)).toMatchObject({
			ok: true,
			value: { idempotent: true, record: first.value.record },
		});
		expect(
			transitionChildAgentRecord(first.value.record, {
				...close,
				attemptReceiptId: "receipt-other",
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
		expect(first.value.record.terminalAt).toBe(succeeded.terminalAt);
	});

	it("rejects result references supplied by close", () => {
		for (const status of ["failed", "lost"] as const) {
			const record = recordAt(status);
			expect(
				transitionChildAgentRecord(
					record,
					transition(record, "closed", 5, {
						attemptReceiptId: `receipt-close-${status}`,
						taskResultId: `result-close-${status}`,
					}),
				),
			).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
		}
	});

	it("preserves valid failed results and close idempotency", () => {
		const running = recordAt("running");
		const failure = transition(running, "failed", 5, {
			attemptReceiptId: "receipt-failed",
			taskResultId: "result-failed",
		});
		const failed = transitionChildAgentRecord(running, failure);
		expect(failed).toMatchObject({
			ok: true,
			value: {
				record: {
					status: "failed",
					attemptReceiptId: "receipt-failed",
					taskResultId: "result-failed",
				},
			},
		});
		if (!failed.ok) return;

		const close = transition(failed.value.record, "closed", 6, {
			attemptReceiptId: "receipt-failed",
			taskResultId: "result-failed",
		});
		const closed = transitionChildAgentRecord(failed.value.record, close);
		expect(closed).toMatchObject({ ok: true, value: { idempotent: false } });
		if (!closed.ok) return;
		expect(transitionChildAgentRecord(closed.value.record, close)).toMatchObject({
			ok: true,
			value: { idempotent: true, record: closed.value.record },
		});
	});

	it("requires a trusted attempt receipt for succeeded and cancelled", () => {
		for (const status of ["succeeded", "cancelled"] as const) {
			const beforeTerminal = recordAt(status === "succeeded" ? "running" : "cancelling");
			const withoutReceipt = transition(beforeTerminal, status, 5, { attemptReceiptId: undefined });
			expect(validateChildAgentTransition(withoutReceipt), status).toBe(false);
			expect(transitionChildAgentRecord(beforeTerminal, withoutReceipt), status).toMatchObject({
				ok: false,
				error: { code: "subagent_conflict" },
			});

			const terminal = recordAt(status);
			expect(validateChildAgentRecord({ ...terminal, attemptReceiptId: undefined }), status).toBe(false);
		}
	});

	it("rejects attempt receipts and task results for lost", () => {
		const spawning = mustCreate();
		for (const references of [
			{ attemptReceiptId: "receipt-lost" },
			{ attemptReceiptId: "receipt-lost", taskResultId: "result-lost" },
		] satisfies ReadonlyArray<Partial<ChildAgentTransition>>) {
			const lost = transition(spawning, "lost", 1, references);
			expect(validateChildAgentTransition(lost)).toBe(false);
			expect(transitionChildAgentRecord(spawning, lost)).toMatchObject({
				ok: false,
				error: { code: "subagent_conflict" },
			});
		}

		const lost = recordAt("lost");
		expect(validateChildAgentRecord({ ...lost, attemptReceiptId: "receipt-lost" })).toBe(false);
		expect(
			validateChildAgentRecord({
				...lost,
				attemptReceiptId: "receipt-lost",
				taskResultId: "result-lost",
			}),
		).toBe(false);
	});

	it("validates exact record and transition shapes", () => {
		const record = mustCreate();
		expect(validateChildAgentRecord(record)).toBe(true);
		expect(validateChildAgentRecord({ ...record, unexpected: true })).toBe(false);
		expect(validateChildAgentRecord({ ...record, ancestorIds: ["parent-2"] })).toBe(false);
		expect(validateChildAgentRecord({ ...record, bindingEpochIds: [] })).toBe(false);
		expect(validateChildAgentTransition(transition(record, "running", 1))).toBe(true);
		expect(validateChildAgentTransition({ ...transition(record, "running", 1), unexpected: true })).toBe(false);
		expect(createChildAgentRecord({ ...creation, depth: 3 })).toMatchObject({
			ok: false,
			error: { code: "subagent_spawn_invalid" },
		});
	});

	it("serializes canonically and rejects forbidden production material", () => {
		const closed = recordAt("closed");
		const serialized = serializeChildAgentRecord(closed);
		expect(parseChildAgentRecord(serialized)).toMatchObject({ ok: true, value: closed });
		expect(serialized).toBe(JSON.stringify(JSON.parse(serialized)));
		expect(Object.keys(JSON.parse(serialized) as object)).toEqual(
			[...Object.keys(JSON.parse(serialized) as object)].sort(),
		);
		for (const key of SUBAGENT_FORBIDDEN_KEYS) {
			const unsafe = { ...closed, [key]: "must-not-persist" };
			expect(validateChildAgentRecord(unsafe), key).toBe(false);
			expect(() => serializeChildAgentRecord(unsafe), key).toThrowError(
				expect.objectContaining({ code: "subagent_spawn_invalid" }),
			);
		}
	});

	it("does not expose spawn execution, budget merging, or terminal authority", () => {
		expect("executeAgentSpawnV1" in subagentContract).toBe(false);
		expect("mergeBudget" in subagentContract).toBe(false);
		expect("settleTaskResult" in subagentContract).toBe(false);
		expect("finalizeRunReceipt" in subagentContract).toBe(false);
	});
});
