import type {
	Attempt,
	AttemptReceipt,
	ExecutionCorrelation,
	FoundationFactRecord,
	PublicExecutionError,
	RunReceipt,
	SideEffectState,
	TaskEnvelope,
	TaskResult,
} from "@aos-agent/agent-core";

import { FOUNDATION_DURABLE_CUSTOM_TYPE } from "../../src/core/session/manager-storage.ts";
import type { SessionEntry } from "../../src/core/session/manager.ts";

export interface CanonicalAuditRunOptions {
	readonly sessionId: string;
	readonly runId: string;
	readonly acceptedAt: string;
	readonly completedAt: string;
	readonly outcome?: RunReceipt["terminalStatus"];
	readonly terminalErrorCode?: string;
	readonly sideEffectState?: SideEffectState;
	readonly usage?: {
		readonly input: number;
		readonly output: number;
		readonly total: number;
	};
	readonly fixtureId?: string;
}

function fixtureSuffix(value: string): string {
	return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function physicalEntry(record: FoundationFactRecord): Extract<SessionEntry, { type: "custom" }> {
	return {
		type: "custom",
		id: `physical-${record.id}`,
		parentId: null,
		timestamp: new Date(record.timestamp).toISOString(),
		customType: FOUNDATION_DURABLE_CUSTOM_TYPE,
		data: { schemaVersion: 1, kind: "durable", record },
	} as Extract<SessionEntry, { type: "custom" }>;
}

/** Build the complete Foundation receipt chain consumed by Execution Audit. */
export function canonicalAuditRunEntries(options: CanonicalAuditRunOptions): Extract<SessionEntry, { type: "custom" }>[] {
	const suffix = fixtureSuffix(options.fixtureId ?? options.runId);
	const taskId = `task-${suffix}`;
	const dispatchId = `dispatch-${suffix}`;
	const attemptId = `attempt-${suffix}`;
	const attemptReceiptId = `attempt-receipt-${suffix}`;
	const taskResultId = `task-result-${suffix}`;
	const runReceiptId = `run-receipt-${suffix}`;
	const bindingId = `binding-${suffix}`;
	const bindingEpochId = `binding-epoch-${suffix}`;
	const outcome = options.outcome ?? "completed";
	const resultStatus = outcome === "completed" ? "succeeded" : outcome;
	const errorCode = options.terminalErrorCode ?? (outcome === "failed" ? "agent_run_failed" : outcome === "cancelled" ? "user_aborted" : undefined);
	const error: PublicExecutionError | undefined = errorCode === undefined
		? undefined
		: { code: errorCode, message: "Run failed.", retryable: false };
	const usage = options.usage ?? { input: 1, output: 1, total: 2 };
	const acceptedTime = Date.parse(options.acceptedAt);
	const completedTime = Date.parse(options.completedAt);
	const factTime = (seq: number): number => seq === 5 ? completedTime : acceptedTime + seq;
	const correlation = (
		extra: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision">,
	): ExecutionCorrelation => ({
		sessionId: options.sessionId,
		laneId: "main",
		revision: 1,
		...extra,
	});
	const fact = <TValue>(
		objectType: string,
		objectId: string,
		seq: number,
		payload: TValue,
		factCorrelation: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision">,
	): FoundationFactRecord => {
		const fencingToken = `fence-${suffix}`;
		return {
			schemaVersion: 1,
			kind: "fact",
			id: `foundation-${suffix}-${objectType}`,
			seq,
			lane: "main",
			timestamp: factTime(seq),
			objectType,
			objectId,
			revision: 1,
			clientRequestId: `${suffix}:${objectType}`,
			fencingToken,
			correlation: { ...correlation(factCorrelation), fencingToken },
			payload: payload as FoundationFactRecord["payload"],
		};
	};
	const task: TaskEnvelope = {
		schemaVersion: 1,
		taskId,
		goalId: `goal-${suffix}`,
		goal: `Execute ${suffix}`,
		kind: "run",
		workspace: "workspace-canonical-audit-test",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: resultStatus,
		createdAt: options.acceptedAt,
		updatedAt: options.completedAt,
	};
	const attempt: Attempt = {
		schemaVersion: 1,
		attemptId,
		dispatchId,
		taskId,
		providerId: "canonical-audit-test",
		bindingId,
		bindingEpochIds: [bindingEpochId],
		status: resultStatus,
		startedAt: options.acceptedAt,
		completedAt: options.completedAt,
	};
	const attemptReceipt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: attempt.providerId,
		bindingId,
		bindingEpochIds: [bindingEpochId],
		status: resultStatus,
		workerReceiptRefs: [],
		artifacts: [],
		...(error === undefined ? {} : { error }),
		provenance: {
			producerKind: "scheduler",
			providerId: "canonical-audit-test",
			producedAt: options.completedAt,
			correlation: correlation({
				taskId,
				dispatchId,
				attemptId,
				attemptReceiptId,
				bindingId,
				bindingEpochId,
				runId: options.runId,
			}),
		},
		sideEffectState: options.sideEffectState ?? "none",
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
		...(error === undefined ? {} : { error }),
		provenance: {
			producerKind: "host",
			providerId: "canonical-audit-test",
			producedAt: options.completedAt,
			correlation: correlation({ taskId, taskResultId, runId: options.runId }),
		},
		validation: {
			schemaValid: outcome === "completed",
			artifactDigestsValid: outcome === "completed",
			acceptanceVerified: outcome === "completed",
			requiredEvidencePresent: outcome === "completed",
		},
	};
	const runReceipt: RunReceipt = {
		schemaVersion: 1,
		runReceiptId,
		runId: options.runId,
		terminalStatus: outcome,
		taskResultId,
		attemptReceiptIds: [attemptReceiptId],
		usage: { inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total },
		...(error === undefined ? {} : { terminalErrorCode: error.code, terminalError: error }),
		completedAt: options.completedAt,
	};
	return [
		fact("task", taskId, 1, task, { taskId }),
		fact("attempt", attemptId, 2, attempt, { taskId, dispatchId, attemptId, bindingId, bindingEpochId, runId: options.runId }),
		fact("attempt_receipt", attemptReceiptId, 3, attemptReceipt, { taskId, dispatchId, attemptId, attemptReceiptId, bindingId, bindingEpochId, runId: options.runId }),
		fact("task_result", taskResultId, 4, taskResult, { taskId, taskResultId, runId: options.runId }),
		fact("run_receipt", options.runId, 5, runReceipt, { taskId, runId: options.runId, runReceiptId, taskResultId, attemptId, attemptReceiptId }),
	].map(physicalEntry);
}
