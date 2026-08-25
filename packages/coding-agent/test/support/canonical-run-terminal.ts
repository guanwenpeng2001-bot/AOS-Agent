import {
	createHostTerminalGateAuthority,
	LayeredResultSettlement,
	Session,
	SessionLedger,
	type AttemptReceipt,
	type Attempt,
	type CanonicalRunResult,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import type { RunHandle, RunStreamEvent } from "../../src/core/run-lifecycle.ts";
import { createSessionManagerStorage } from "../../src/core/session-manager-storage.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";

export type CanonicalTerminalOutcome = "completed" | "failed" | "cancelled";

export interface CanonicalTerminalOptions {
	readonly outcome: CanonicalTerminalOutcome;
	readonly sideEffectState?: AttemptReceipt["sideEffectState"];
	readonly terminalErrorCode?: string;
	readonly completedAt?: string;
	readonly usage?: {
		readonly input: number;
		readonly output: number;
		readonly total: number;
	};
}

export interface ObservedCanonicalTerminal {
	readonly canonical: CanonicalRunResult;
	readonly event: RunStreamEvent | undefined;
}

const DEFAULT_COMPLETED_AT = "2026-08-26T00:00:00.000Z";

function fixtureSuffix(runId: string): string {
	return runId.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function attemptStatus(outcome: CanonicalTerminalOutcome): AttemptReceipt["status"] {
	if (outcome === "completed") return "succeeded";
	if (outcome === "cancelled") return "cancelled";
	return "failed";
}

function errorCode(options: CanonicalTerminalOptions): string | undefined {
	if (options.outcome === "completed") return undefined;
	if (options.terminalErrorCode !== undefined) return options.terminalErrorCode;
	if (options.sideEffectState === "side_effect_unknown") return "side_effect_unknown";
	return options.outcome === "cancelled" ? "user_aborted" : "agent_run_failed";
}

/**
 * Write one canonical Foundation terminal chain for an Automation Run.
 *
 * This helper deliberately uses SessionLedger and LayeredResultSettlement. It
 * never creates the retired private `automation.run` terminal fact.
 */
export async function writeCanonicalRunResult(
	sessionManager: SessionManager,
	runId: string,
	options: CanonicalTerminalOptions,
): Promise<CanonicalRunResult> {
	const sessionId = sessionManager.getSessionId();
	const suffix = fixtureSuffix(runId);
	const taskId = `task-${suffix}`;
	const goalId = `goal-${suffix}`;
	const attemptReceiptId = `attempt-receipt-${suffix}`;
	const taskResultId = `task-result-${suffix}`;
	const dispatchId = `dispatch-${suffix}`;
	const attemptId = `attempt-${suffix}`;
	const bindingId = `binding-${suffix}`;
	const bindingEpochId = `binding-epoch-${suffix}`;
	const completedAt = options.completedAt ?? DEFAULT_COMPLETED_AT;
	const status = attemptStatus(options.outcome);
	const terminalErrorCode = errorCode(options);
	const sideEffectState = options.sideEffectState ?? "none";
	const task: TaskEnvelope = {
		schemaVersion: 1,
		taskId,
		goalId,
		goal: "Exercise the canonical Automation Run terminal projection",
		workspace: "workspace-canonical-run-test",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: completedAt,
		updatedAt: completedAt,
	};
	const attemptReceipt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: "canonical-run-test",
		bindingId,
		bindingEpochIds: [bindingEpochId],
		status,
		workerReceiptRefs: [],
		artifacts: [],
		...(terminalErrorCode === undefined
			? {}
			: {
					error: {
						code: terminalErrorCode,
						message: "Run failed.",
						retryable: false,
					},
				}),
		provenance: {
			producerKind: "scheduler",
			providerId: "canonical-run-test",
			producedAt: completedAt,
			correlation: {
				sessionId,
				laneId: "main",
				taskId,
				dispatchId,
				attemptId,
				bindingId,
				bindingEpochId,
				attemptReceiptId,
				revision: 1,
			},
		},
		sideEffectState,
	};
	const attempt: Attempt = {
		schemaVersion: 1,
		attemptId,
		dispatchId,
		taskId,
		providerId: "canonical-run-test",
		bindingId,
		bindingEpochIds: [bindingEpochId],
		status,
		startedAt: completedAt,
		completedAt,
	};
	const session = new Session(createSessionManagerStorage(sessionManager));
	const ledger = new SessionLedger(session, { ownerId: `canonical-run-seed-${suffix}` });
	try {
		await ledger.appendFact("task", taskId, task, {
			clientRequestId: `canonical-run:task:${suffix}`,
			expectedRevision: 0,
			correlation: { taskId, goalId },
		});
		await ledger.appendFact("attempt", attemptId, attempt, {
			clientRequestId: `canonical-run:attempt-record:${suffix}`,
			expectedRevision: 0,
			correlation: { taskId, dispatchId, attemptId, bindingId, bindingEpochId },
		});
		await ledger.appendFact("attempt_receipt", attemptReceiptId, attemptReceipt, {
			clientRequestId: `canonical-run:attempt:${suffix}`,
			expectedRevision: 0,
			correlation: {
				taskId,
				dispatchId,
				attemptId,
				attemptReceiptId,
				bindingId,
				bindingEpochId,
			},
		});
	} finally {
		await ledger.release();
	}

	const settlement = new LayeredResultSettlement(session, { ownerId: `canonical-run-settlement-${suffix}` });
	try {
		const taskResult = await settlement.settle({
			taskResultId,
			task,
			sourceAttemptReceiptIds: [attemptReceiptId],
			summary: "canonical Automation Run terminal",
			artifacts: [],
			tests: [],
			evidence: [],
			producer: {
				producerKind: "host",
				providerId: "canonical-run-test",
				producedAt: completedAt,
				correlation: {
					sessionId,
					laneId: "main",
					taskId,
					taskResultId,
					attemptReceiptId,
					revision: 1,
				},
			},
		});
		if (!taskResult.ok) throw taskResult.error;
		const usage = options.usage ?? { input: 0, output: 0, total: 0 };
		const finalized = await settlement.finalize({
			runReceiptId: `run-receipt-${suffix}`,
			runId,
			terminalStatus: options.outcome,
			authority: createHostTerminalGateAuthority("canonical-run-test"),
			attemptReceiptIds: [attemptReceiptId],
			taskResultId,
			usage: {
				inputTokens: usage.input,
				outputTokens: usage.output,
				totalTokens: usage.total,
			},
			...(terminalErrorCode === undefined ? {} : { terminalErrorCode }),
			completedAt,
		});
		if (!finalized.ok) throw finalized.error;
		const lookup = await settlement.lookupCanonicalRun(runId);
		if (!lookup.ok) throw lookup.error;
		if (lookup.value === undefined) throw new Error(`Canonical Run result was not found for ${runId}`);
		return lookup.value;
	} finally {
		await settlement.release();
	}
}

/** Write the Foundation result and project it through the Automation observer. */
export async function observeCanonicalTerminal(
	sessionManager: SessionManager,
	run: RunHandle,
	options: CanonicalTerminalOptions,
): Promise<ObservedCanonicalTerminal> {
	const canonical = await writeCanonicalRunResult(sessionManager, run.runId, options);
	return { canonical, event: run.observeCanonicalResult(canonical) };
}
