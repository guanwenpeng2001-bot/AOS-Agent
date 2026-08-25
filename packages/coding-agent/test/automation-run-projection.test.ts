import {
	createDurableEvent,
	type AttemptReceipt,
	type DurableEventEnvelope,
	type ExecutionCorrelation,
	type FoundationFactRecord,
	type FoundationJsonValue,
	type PublicExecutionError,
	type ResultStatus,
	type SideEffectState,
	type TaskResult,
	type WorkerReceipt,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	AutomationRunProjectionError,
	projectAutomationRuns,
	type CanonicalAutomationRunReceiptSource,
} from "../src/core/automation-run-projection.ts";

const SESSION_ID = "session-projection";
const LANE_ID = "main";

function correlation(fields: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision"> = {}): ExecutionCorrelation {
	return { sessionId: SESSION_ID, laneId: LANE_ID, revision: 1, ...fields };
}

function fact(
	seq: number,
	objectType: string,
	objectId: string,
	payload: FoundationJsonValue,
	fields: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision">,
	id = `fact-${seq}`,
): FoundationFactRecord {
	return {
		schemaVersion: 1,
		kind: "fact",
		id,
		seq,
		lane: LANE_ID,
		timestamp: Date.parse("2026-08-25T10:00:00.000Z") + seq,
		objectType,
		objectId,
		revision: 1,
		clientRequestId: `request-${seq}`,
		fencingToken: "fence-1",
		correlation: { ...correlation(fields), fencingToken: "fence-1" },
		payload,
	};
}

interface ChainOptions {
	readonly suffix?: string;
	readonly runStatus?: CanonicalAutomationRunReceiptSource["terminalStatus"];
	readonly resultStatus?: ResultStatus;
	readonly attemptStatus?: ResultStatus;
	readonly sideEffectState?: SideEffectState;
	readonly error?: PublicExecutionError;
	readonly terminalErrorCode?: string;
}

interface CanonicalChain {
	readonly records: FoundationFactRecord[];
	readonly events: DurableEventEnvelope[];
	readonly runId: string;
	readonly runReceipt: CanonicalAutomationRunReceiptSource;
}

function chain(options: ChainOptions = {}): CanonicalChain {
	const suffix = options.suffix ?? "completed";
	const runId = `run-${suffix}`;
	const taskId = `task-${suffix}`;
	const dispatchId = `dispatch-${suffix}`;
	const attemptId = `attempt-${suffix}`;
	const attemptReceiptId = `attempt-receipt-${suffix}`;
	const workerReceiptId = `worker-receipt-${suffix}`;
	const taskResultId = `task-result-${suffix}`;
	const runReceiptId = `run-receipt-${suffix}`;
	const runStatus = options.runStatus ?? "completed";
	const resultStatus = options.resultStatus ?? "succeeded";
	const attemptStatus = options.attemptStatus ?? resultStatus;
	const sideEffectState = options.sideEffectState ?? "none";
	const worker: WorkerReceipt = {
		schemaVersion: 1,
		workerReceiptId,
		sandboxProviderId: "sandbox.fixture",
		operationId: `operation-${suffix}`,
		taskId,
		dispatchId,
		attemptId,
		status: attemptStatus,
		sideEffectState,
		...(options.error === undefined ? {} : { error: options.error }),
		provenance: {
			producerKind: "operation_worker",
			providerId: "sandbox.fixture",
			producedAt: "2026-08-25T10:00:02.000Z",
			correlation: correlation({ taskId, dispatchId, attemptId, operationId: `operation-${suffix}` }),
		},
		startedAt: "2026-08-25T10:00:01.000Z",
		completedAt: "2026-08-25T10:00:02.000Z",
	};
	const attempt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: "scheduler.fixture",
		bindingId: `binding-${suffix}`,
		bindingEpochIds: [`epoch-${suffix}`],
		status: attemptStatus,
		workerReceiptRefs: [{ schemaVersion: 1, type: "worker_receipt", id: workerReceiptId, revision: 1 }],
		artifacts: [],
		...(options.error === undefined ? {} : { error: options.error }),
		provenance: {
			producerKind: "scheduler",
			providerId: "scheduler.fixture",
			producedAt: "2026-08-25T10:00:03.000Z",
			correlation: correlation({
				taskId,
				dispatchId,
				attemptId,
				attemptReceiptId,
				bindingId: `binding-${suffix}`,
				bindingEpochId: `epoch-${suffix}`,
			}),
		},
		sideEffectState,
	};
	const taskResult: TaskResult = {
		schemaVersion: 1,
		taskResultId,
		taskId,
		sourceAttemptReceiptIds: [attemptReceiptId],
		status: resultStatus,
		summary: `Task ${suffix} summary`,
		artifacts: [],
		tests: [],
		evidence: [],
		...(options.error === undefined ? {} : { error: options.error }),
		provenance: {
			producerKind: "host",
			providerId: "host.fixture",
			producedAt: "2026-08-25T10:00:04.000Z",
			correlation: correlation({ taskId, taskResultId }),
		},
		validation: {
			schemaValid: resultStatus === "succeeded",
			artifactDigestsValid: resultStatus === "succeeded",
			acceptanceVerified: resultStatus === "succeeded",
			requiredEvidencePresent: resultStatus === "succeeded",
		},
	};
	const runReceipt: CanonicalAutomationRunReceiptSource = {
		schemaVersion: 1,
		runReceiptId,
		runId,
		terminalStatus: runStatus,
		taskResultId,
		attemptReceiptIds: [attemptReceiptId],
		...(options.terminalErrorCode === undefined ? {} : { terminalErrorCode: options.terminalErrorCode }),
		usage: { input: 10, output: 5, totalTokens: 15 },
		...(options.error === undefined ? {} : { terminalError: options.error }),
		completedAt: "2026-08-25T10:00:05.000Z",
	};
	const records = [
		fact(1, "worker_receipt", workerReceiptId, worker as unknown as FoundationJsonValue, { taskId, dispatchId, attemptId }),
		fact(2, "attempt_receipt", attemptReceiptId, attempt as unknown as FoundationJsonValue, {
			taskId,
			dispatchId,
			attemptId,
			attemptReceiptId,
		}),
		fact(3, "task_result", taskResultId, taskResult as unknown as FoundationJsonValue, { taskId, taskResultId }),
		fact(4, "run_receipt", runId, runReceipt as unknown as FoundationJsonValue, { runId, runReceiptId, taskResultId }),
	];
	const events = [
		createDurableEvent({
			category: "attempt.started",
			eventId: `event-attempt-started-${suffix}`,
			streamId: `stream-${suffix}`,
			sequence: 10,
			timestamp: "2026-08-25T10:00:00.000Z",
			correlation: { sessionId: SESSION_ID, runId, taskId, dispatchId, attemptId },
			payload: { schemaVersion: 1, taskId, dispatchId, attemptId },
		}),
		createDurableEvent({
			category: "run_receipt.written",
			eventId: `event-run-receipt-${suffix}`,
			streamId: `stream-${suffix}`,
			sequence: 1,
			timestamp: "2026-08-25T10:00:05.000Z",
			correlation: { sessionId: SESSION_ID, runId, runReceiptId },
			payload: { schemaVersion: 1, runId, runReceiptId },
		}),
		createDurableEvent({
			category: "usage.recorded",
			eventId: `event-usage-${suffix}`,
			streamId: `stream-${suffix}`,
			sequence: 7,
			timestamp: "2026-08-25T10:00:04.000Z",
			correlation: { sessionId: SESSION_ID, runId },
			payload: { schemaVersion: 1, input: 100, output: 50, total: 150 },
		}),
	];
	return { records, events, runId, runReceipt };
}

describe("canonical Automation Run projection", () => {
	it("projects only canonically supported public Run fields", () => {
		const fixture = chain();
		expect(projectAutomationRuns(fixture)).toEqual([
			{
				id: fixture.runId,
				sessionId: SESSION_ID,
				status: "completed",
				startedAt: "2026-08-25T10:00:00.000Z",
				endedAt: "2026-08-25T10:00:05.000Z",
				terminal: {
					runId: fixture.runId,
					sessionId: SESSION_ID,
					status: "completed",
					usage: { input: 10, output: 5, total: 15 },
				},
				canonicalResult: {
					runReceiptId: fixture.runReceipt.runReceiptId,
					taskResultId: fixture.runReceipt.taskResultId,
					attemptReceiptIds: fixture.runReceipt.attemptReceiptIds,
					taskSummary: "Task completed summary",
					sideEffectState: "none",
				},
			},
		]);
		const terminal = projectAutomationRuns(fixture)[0]?.terminal;
		expect(terminal?.usage).toEqual({ input: 10, output: 5, total: 15 });
		expect(terminal).not.toHaveProperty("finalText");
		expect(projectAutomationRuns(fixture)[0]).not.toHaveProperty("model");
	});

	it.each([
		{
			name: "failed",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: { code: "agent_run_failed", message: "failed", category: "unknown", retryable: false },
			terminalErrorCode: "agent_run_failed",
			sideEffectState: "none",
		},
		{
			name: "cancelled",
			runStatus: "cancelled",
			resultStatus: "cancelled",
			attemptStatus: "cancelled",
			error: { code: "user_aborted", message: "cancelled", category: "cancelled", retryable: false },
			terminalErrorCode: "user_aborted",
			sideEffectState: "none",
		},
		{
			name: "deadline",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: { code: "run_deadline_exceeded", message: "deadline", category: "deadline", retryable: false },
			terminalErrorCode: "run_deadline_exceeded",
			sideEffectState: "none",
		},
		{
			name: "side-effect-unknown",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: { code: "side_effect_unknown", message: "unknown effect", category: "side_effect_unknown", retryable: false },
			terminalErrorCode: "side_effect_unknown",
			sideEffectState: "side_effect_unknown",
		},
	] as const)("maps the $name outcome from canonical results", (scenario) => {
		const fixture = chain({ ...scenario, suffix: scenario.name });
		const projected = projectAutomationRuns(fixture)[0];
		expect(projected).toMatchObject({
			status: scenario.runStatus,
			terminalError: scenario.error,
			canonicalResult: { sideEffectState: scenario.sideEffectState },
		});
	});

	it("projects terminal error only from the canonical RunReceipt", () => {
		const receiptError: PublicExecutionError = {
			code: "run_deadline_exceeded",
			message: "canonical deadline",
			category: "deadline",
			retryable: false,
		};
		const lowerError: PublicExecutionError = {
			code: "provider_failed",
			message: "lower result detail",
			category: "unknown",
			retryable: true,
		};
		const fixture = chain({
			suffix: "receipt-error",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: receiptError,
			terminalErrorCode: receiptError.code,
		});
		const records = fixture.records.map((record) => {
			if (record.objectType === "run_receipt") return record;
			return {
				...record,
				payload: {
					...(record.payload as Record<string, FoundationJsonValue>),
					error: lowerError as unknown as FoundationJsonValue,
				} as FoundationJsonValue,
			};
		});
		expect(projectAutomationRuns({ records, events: fixture.events })[0]?.terminalError).toEqual(receiptError);
	});

	it("is deterministic across duplicates, out-of-order input, and restart replay", () => {
		const fixture = chain();
		const second = chain({ suffix: "second" });
		const duplicateRun = { ...fixture.records.at(-1)!, id: "fact-run-duplicate", seq: 40 };
		const first = projectAutomationRuns({
			records: [...fixture.records, duplicateRun, ...second.records].reverse(),
			events: [...fixture.events, fixture.events[0]!, ...second.events].reverse(),
		});
		const restarted = projectAutomationRuns({
			records: [...fixture.records, duplicateRun, ...second.records],
			events: [...fixture.events, fixture.events[0]!, ...second.events],
		});
		expect(first).toHaveLength(2);
		expect(first).toEqual(restarted);
	});

	it("fails closed on conflicting duplicate terminal facts", () => {
		const fixture = chain();
		const runFact = fixture.records.at(-1)!;
		const conflicting: CanonicalAutomationRunReceiptSource = {
			...fixture.runReceipt,
			terminalStatus: "failed",
			terminalErrorCode: "conflict",
			terminalError: { code: "conflict", message: "conflict", retryable: false },
		};
		expect(() => projectAutomationRuns({
			records: [
				...fixture.records,
				{ ...runFact, id: "fact-run-conflict", seq: 50, payload: conflicting as unknown as FoundationJsonValue },
			],
			events: fixture.events,
		})).toThrow(AutomationRunProjectionError);
	});

	it("fails closed when a canonical result reference is missing", () => {
		const fixture = chain();
		expect(() => projectAutomationRuns({ records: fixture.records.slice(1), events: fixture.events }))
			.toThrow(/missing WorkerReceipt/u);
	});

	it("requires usage on the immutable canonical RunReceipt fact", () => {
		const fixture = chain();
		const runFact = fixture.records.at(-1)!;
		const { usage: _usage, ...withoutUsage } = fixture.runReceipt;
		expect(() => projectAutomationRuns({
			records: [
				...fixture.records.slice(0, -1),
				{ ...runFact, payload: withoutUsage as unknown as FoundationJsonValue },
			],
			events: fixture.events,
		})).toThrow(/missing usage/u);
	});

	it("requires the canonical terminal error and stable code to agree", () => {
		const fixture = chain({
			suffix: "error-conflict",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: { code: "canonical_failure", message: "failure", retryable: false },
			terminalErrorCode: "canonical_failure",
		});
		const runFact = fixture.records.at(-1)!;
		const conflicting = { ...fixture.runReceipt, terminalErrorCode: "different_failure" };
		expect(() => projectAutomationRuns({
			records: [
				...fixture.records.slice(0, -1),
				{ ...runFact, payload: conflicting as unknown as FoundationJsonValue },
			],
			events: fixture.events,
		})).toThrow(/Terminal error conflicts/u);
	});
});
