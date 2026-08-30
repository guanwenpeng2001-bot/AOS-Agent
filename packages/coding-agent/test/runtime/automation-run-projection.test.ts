import {
	createDurableEvent,
	type AttemptReceipt,
	type CanonicalRunResult,
	type DurableEventEnvelope,
	type ExecutionCorrelation,
	type PublicExecutionError,
	type ResultStatus,
	type RunReceipt,
	type SideEffectState,
	type TaskResult,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import { AutomationRunProjectionError, projectAutomationRuns } from "../../src/core/session/automation-run-projection.ts";

const SESSION_ID = "session-projection";
const LANE_ID = "main";

function correlation(fields: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision"> = {}): ExecutionCorrelation {
	return { sessionId: SESSION_ID, laneId: LANE_ID, revision: 1, ...fields };
}

interface ChainOptions {
	readonly suffix?: string;
	readonly runStatus?: RunReceipt["terminalStatus"];
	readonly resultStatus?: ResultStatus;
	readonly attemptStatus?: ResultStatus;
	readonly sideEffectState?: SideEffectState;
	readonly error?: PublicExecutionError;
	readonly terminalErrorCode?: string;
}

interface CanonicalChain {
	readonly canonicalRun: CanonicalRunResult;
	readonly events: DurableEventEnvelope[];
	readonly runId: string;
	readonly runReceipt: RunReceipt;
}

function chain(options: ChainOptions = {}): CanonicalChain {
	const suffix = options.suffix ?? "completed";
	const runId = `run-${suffix}`;
	const taskId = `task-${suffix}`;
	const dispatchId = `dispatch-${suffix}`;
	const attemptId = `attempt-${suffix}`;
	const attemptReceiptId = `attempt-receipt-${suffix}`;
	const taskResultId = `task-result-${suffix}`;
	const runReceiptId = `run-receipt-${suffix}`;
	const runStatus = options.runStatus ?? "completed";
	const resultStatus = options.resultStatus ?? "succeeded";
	const attemptStatus = options.attemptStatus ?? resultStatus;
	const sideEffectState = options.sideEffectState ?? "none";
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
		workerReceiptRefs: [{ schemaVersion: 1, type: "worker_receipt", id: `worker-receipt-${suffix}`, revision: 1 }],
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
	const runReceipt: RunReceipt = {
		schemaVersion: 1,
		runReceiptId,
		runId,
		terminalStatus: runStatus,
		taskResultId,
		attemptReceiptIds: [attemptReceiptId],
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		...(options.terminalErrorCode === undefined ? {} : { terminalErrorCode: options.terminalErrorCode }),
		...(options.error === undefined ? {} : { terminalError: options.error }),
		completedAt: "2026-08-25T10:00:05.000Z",
	};
	const attemptStarted = createDurableEvent({
		category: "attempt.started",
		eventId: `event-attempt-started-${suffix}`,
		streamId: `stream-${suffix}`,
		sequence: 10,
		timestamp: "2026-08-25T10:00:00.000Z",
		correlation: { sessionId: SESSION_ID, runId, taskId, dispatchId, attemptId },
		payload: { schemaVersion: 1, taskId, dispatchId, attemptId },
	});
	const writtenEvent = createDurableEvent({
		category: "run_receipt.written",
		eventId: `event-run-receipt-${suffix}`,
		streamId: `stream-${suffix}`,
		sequence: 1,
		timestamp: "2026-08-25T10:00:05.000Z",
		correlation: { sessionId: SESSION_ID, runId, runReceiptId },
		payload: { schemaVersion: 1, runId, runReceiptId },
	});
	const usageRecorded = createDurableEvent({
		category: "usage.recorded",
		eventId: `event-usage-${suffix}`,
		streamId: `stream-${suffix}`,
		sequence: 7,
		timestamp: "2026-08-25T10:00:04.000Z",
		correlation: { sessionId: SESSION_ID, runId },
		payload: { schemaVersion: 1, input: 100, output: 50, total: 150 },
	});
	return {
		canonicalRun: { schemaVersion: 1, runReceipt, taskResult, attemptReceipts: [attempt], writtenEvent },
		events: [attemptStarted, writtenEvent, usageRecorded],
		runId,
		runReceipt,
	};
}

function project(fixture: CanonicalChain) {
	return projectAutomationRuns({ canonicalRuns: [fixture.canonicalRun], events: fixture.events });
}

describe("canonical Automation Run projection", () => {
	it("projects only canonically supported public Run fields", () => {
		const fixture = chain();
		expect(project(fixture)).toEqual([
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
		const terminal = project(fixture)[0]?.terminal;
		expect(terminal?.usage).toEqual({ input: 10, output: 5, total: 15 });
		expect(terminal).not.toHaveProperty("finalText");
		expect(project(fixture)[0]).not.toHaveProperty("model");
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
		{
			name: "external-mapping-conflict",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: {
				code: "external_mapping_conflict",
				message: "mapping collision",
				category: "side_effect_unknown",
				retryable: false,
			},
			terminalErrorCode: "external_mapping_conflict",
			sideEffectState: "side_effect_unknown",
		},
	] as const)("maps the $name outcome from canonical results", (scenario) => {
		const fixture = chain({ ...scenario, suffix: scenario.name });
		const projected = project(fixture)[0];
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
		const canonicalRun: CanonicalRunResult = {
			...fixture.canonicalRun,
			taskResult: { ...fixture.canonicalRun.taskResult!, error: lowerError },
			attemptReceipts: fixture.canonicalRun.attemptReceipts.map((attempt) => ({ ...attempt, error: lowerError })),
		};
		expect(projectAutomationRuns({ canonicalRuns: [canonicalRun], events: fixture.events })[0]?.terminalError)
			.toEqual(receiptError);
	});

	it("is deterministic across duplicates, out-of-order input, and restart replay", () => {
		const fixture = chain();
		const second = chain({ suffix: "second" });
		const first = projectAutomationRuns({
			canonicalRuns: [second.canonicalRun, fixture.canonicalRun, fixture.canonicalRun],
			events: [...fixture.events, fixture.events[0]!, ...second.events].reverse(),
		});
		const restarted = projectAutomationRuns({
			canonicalRuns: [fixture.canonicalRun, fixture.canonicalRun, second.canonicalRun],
			events: [...fixture.events, fixture.events[0]!, ...second.events],
		});
		expect(first).toHaveLength(2);
		expect(first).toEqual(restarted);
	});

	it("deduplicates an exact replay of the canonical terminal event", () => {
		const fixture = chain();
		const replayed = projectAutomationRuns({
			canonicalRuns: [fixture.canonicalRun],
			events: [...fixture.events, structuredClone(fixture.canonicalRun.writtenEvent)],
		});
		expect(replayed).toEqual(project(fixture));
	});

	it("fails closed on a cross-Session terminal event for the canonical Run", () => {
		const fixture = chain();
		const authority = fixture.canonicalRun.writtenEvent;
		const conflicting = createDurableEvent({
			category: "run_receipt.written",
			eventId: `${authority.eventId}-other-session`,
			streamId: `${authority.streamId}-other-session`,
			sequence: authority.sequence,
			timestamp: authority.timestamp,
			correlation: { ...authority.correlation, sessionId: "session-other" },
			payload: authority.payload,
		});
		expect(() => projectAutomationRuns({
			canonicalRuns: [fixture.canonicalRun],
			events: [...fixture.events, conflicting],
		})).toThrow(/run_receipt\.written event conflicts/u);
	});

	it("fails closed when terminal evidence uses a different sequence", () => {
		const fixture = chain();
		const authority = fixture.canonicalRun.writtenEvent;
		const conflicting = createDurableEvent({
			category: "run_receipt.written",
			eventId: `${authority.eventId}-later-sequence`,
			streamId: authority.streamId,
			sequence: authority.sequence + 1,
			timestamp: authority.timestamp,
			correlation: authority.correlation,
			payload: authority.payload,
		});
		expect(() => projectAutomationRuns({
			canonicalRuns: [fixture.canonicalRun],
			events: [...fixture.events, conflicting],
		})).toThrow(/run_receipt\.written event conflicts/u);
	});

	it("fails closed when a terminal event cross-correlates one Run with another receipt", () => {
		const first = chain({ suffix: "cross-first" });
		const second = chain({ suffix: "cross-second" });
		const conflicting = createDurableEvent({
			category: "run_receipt.written",
			eventId: "event-run-receipt-cross-correlation",
			streamId: "stream-cross-correlation",
			sequence: 1,
			timestamp: "2026-08-25T10:00:05.000Z",
			correlation: {
				sessionId: SESSION_ID,
				runId: second.runId,
				runReceiptId: first.runReceipt.runReceiptId,
			},
			payload: {
				schemaVersion: 1,
				runId: second.runId,
				runReceiptId: first.runReceipt.runReceiptId,
			},
		});
		expect(() => projectAutomationRuns({
			canonicalRuns: [first.canonicalRun, second.canonicalRun],
			events: [...first.events, ...second.events, conflicting],
		})).toThrow(/run_receipt\.written event conflicts/u);
	});

	it("fails closed on conflicting duplicate canonical results", () => {
		const fixture = chain();
		const conflicting: CanonicalRunResult = {
			...fixture.canonicalRun,
			runReceipt: {
				...fixture.runReceipt,
				terminalStatus: "failed",
				terminalErrorCode: "conflict",
				terminalError: { code: "conflict", message: "conflict", retryable: false },
			},
		};
		expect(() => projectAutomationRuns({
			canonicalRuns: [fixture.canonicalRun, conflicting],
			events: fixture.events,
		})).toThrow(AutomationRunProjectionError);
	});

	it("fails closed when a canonical result reference is missing", () => {
		const fixture = chain();
		const canonicalRun = { ...fixture.canonicalRun, attemptReceipts: [] };
		expect(() => projectAutomationRuns({ canonicalRuns: [canonicalRun], events: fixture.events }))
			.toThrow(/missing or duplicate AttemptReceipt references/u);
	});

	it("requires usage on the final canonical RunReceipt", () => {
		const fixture = chain();
		const { usage: _usage, ...withoutUsage } = fixture.runReceipt;
		const canonicalRun: CanonicalRunResult = {
			...fixture.canonicalRun,
			runReceipt: withoutUsage as unknown as RunReceipt,
		};
		expect(() => projectAutomationRuns({ canonicalRuns: [canonicalRun], events: fixture.events }))
			.toThrow(AutomationRunProjectionError);
	});

	it("requires the final canonical terminal error and stable code to agree", () => {
		const fixture = chain({
			suffix: "error-conflict",
			runStatus: "failed",
			resultStatus: "failed",
			attemptStatus: "failed",
			error: { code: "canonical_failure", message: "failure", retryable: false },
			terminalErrorCode: "canonical_failure",
		});
		const canonicalRun: CanonicalRunResult = {
			...fixture.canonicalRun,
			runReceipt: { ...fixture.runReceipt, terminalErrorCode: "different_failure" },
		};
		expect(() => projectAutomationRuns({ canonicalRuns: [canonicalRun], events: fixture.events }))
			.toThrow(AutomationRunProjectionError);
	});
});
