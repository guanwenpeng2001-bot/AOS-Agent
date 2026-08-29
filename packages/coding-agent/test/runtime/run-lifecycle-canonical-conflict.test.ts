import {
	type AttemptReceipt,
	DurableLedgerError,
	FoundationError,
	type FoundationFactRecord,
	type RunReceipt,
	type TaskResult,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { PrivateMigrationError } from "../../src/core/migrations/session-entry.ts";
import {
	createRunLifecycleCoordinator,
	type RunLedgerSession,
	type RunModelReference,
} from "../../src/core/session/run-lifecycle.ts";
import { SessionManager } from "../../src/core/session/manager.ts";

const FOUNDATION_CUSTOM_TYPE = "__aos.foundation.durable.v1";
const MODEL: RunModelReference = { provider: "test", id: "model", thinkingLevel: "off" };
const COMPLETED_AT = "2026-08-26T00:00:03.000Z";
const LANE_ID = "main";

interface FoundationFactInput {
	readonly id: string;
	readonly objectType: string;
	readonly objectId: string;
	readonly payload: unknown;
	readonly sourceCorrelation?: object;
	readonly revision?: number;
}

function createFoundationFact(session: RunLedgerSession, input: FoundationFactInput): FoundationFactRecord {
	const revision = input.revision ?? 1;
	const sequence = (session.getPhysicalEntries?.() ?? session.getEntries()).length + 1;
	const fencingToken = `fence-${session.getSessionId()}`;
	const sourceCorrelation = Object.fromEntries(
		Object.entries(input.sourceCorrelation ?? {}).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	return {
		schemaVersion: 1,
		kind: "fact",
		id: input.id,
		seq: sequence,
		lane: LANE_ID,
		timestamp: Date.parse(COMPLETED_AT) + sequence,
		objectType: input.objectType,
		objectId: input.objectId,
		revision,
		clientRequestId: `client-${input.id}`,
		expectedRevision: revision - 1,
		fencingToken,
		correlation: {
			...sourceCorrelation,
			sessionId: session.getSessionId(),
			laneId: LANE_ID,
			revision,
			fencingToken,
		},
		payload: input.payload as FoundationFactRecord["payload"],
	};
}

function appendFoundationRecord(session: RunLedgerSession, record: unknown): void {
	session.appendCustomEntry(FOUNDATION_CUSTOM_TYPE, {
		schemaVersion: 1,
		kind: "durable",
		record,
	});
}

function appendFoundationFact(session: RunLedgerSession, input: FoundationFactInput): FoundationFactRecord {
	const record = createFoundationFact(session, input);
	appendFoundationRecord(session, record);
	return record;
}

function appendCanonicalChain(
	session: RunLedgerSession,
	runId: string,
	options: { readonly conflictingDuplicate?: boolean; readonly runCorrelation?: object } = {},
): void {
	const sessionId = session.getSessionId();
	const taskId = `task-${runId}`;
	const dispatchId = `dispatch-${runId}`;
	const attemptId = `attempt-${runId}`;
	const attemptReceiptId = `attempt-receipt-${runId}`;
	const taskResultId = `task-result-${runId}`;
	const runReceiptId = `run-receipt-${runId}`;
	const attempt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: "test.provider",
		bindingId: `binding-${runId}`,
		bindingEpochIds: [`epoch-${runId}`],
		status: "succeeded",
		workerReceiptRefs: [{ schemaVersion: 1, type: "worker_receipt", id: `worker-${runId}`, revision: 1 }],
		artifacts: [],
		provenance: {
			producerKind: "scheduler",
			providerId: "test.provider",
			producedAt: "2026-08-26T00:00:01.000Z",
			correlation: {
				sessionId,
				laneId: "main",
				revision: 1,
				taskId,
				dispatchId,
				attemptId,
				attemptReceiptId,
				bindingId: `binding-${runId}`,
				bindingEpochId: `epoch-${runId}`,
			},
		},
		sideEffectState: "none",
	};
	const taskResult: TaskResult = {
		schemaVersion: 1,
		taskResultId,
		taskId,
		sourceAttemptReceiptIds: [attemptReceiptId],
		status: "succeeded",
		summary: "completed",
		artifacts: [],
		tests: [],
		evidence: [],
		provenance: {
			producerKind: "host",
			providerId: "test.host",
			producedAt: "2026-08-26T00:00:02.000Z",
			correlation: { sessionId, laneId: "main", revision: 1, taskId, taskResultId },
		},
		validation: {
			schemaValid: true,
			artifactDigestsValid: true,
			acceptanceVerified: true,
			requiredEvidencePresent: true,
		},
	};
	const receipt: RunReceipt = {
		schemaVersion: 1,
		runReceiptId,
		runId,
		terminalStatus: "completed",
		taskResultId,
		attemptReceiptIds: [attemptReceiptId],
		usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
		completedAt: COMPLETED_AT,
	};
	appendFoundationFact(session, {
		id: `fact-attempt-${runId}`,
		objectType: "attempt_receipt",
		objectId: attemptReceiptId,
		payload: attempt,
		sourceCorrelation: attempt.provenance.correlation,
	});
	appendFoundationFact(session, {
		id: `fact-task-${runId}`,
		objectType: "task_result",
		objectId: taskResultId,
		payload: taskResult,
		sourceCorrelation: taskResult.provenance.correlation,
	});
	appendFoundationFact(session, {
		id: `fact-run-${runId}`,
		objectType: "run_receipt",
		objectId: runId,
		payload: receipt,
		sourceCorrelation: options.runCorrelation ?? {
			taskId,
			runId,
			runReceiptId,
			taskResultId,
			attemptId,
			attemptReceiptId,
		},
	});
	if (options.conflictingDuplicate) {
		appendFoundationFact(session, {
			id: `fact-run-conflict-${runId}`,
			objectType: "run_receipt",
			objectId: runId,
			payload: { ...receipt, usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
			revision: 2,
			sourceCorrelation: {
				taskId,
				runId,
				runReceiptId,
				taskResultId,
				attemptId,
				attemptReceiptId,
			},
		});
	}
}

function appendLegacyRun(session: RunLedgerSession, runId: string, usageTotal = 3): void {
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: runId,
			sessionId: session.getSessionId(),
			attempt: 1,
			status: "accepted",
			model: MODEL,
		},
	});
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "started",
		runId,
		startedAt: "2026-08-26T00:00:00.000Z",
	});
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "terminal",
		endedAt: COMPLETED_AT,
		receipt: {
			runId,
			sessionId: session.getSessionId(),
			status: "completed",
			usage: { input: 1, output: 2, total: usageTotal },
		},
	});
}

describe("Run lifecycle canonical conflict boundaries", () => {
	it("rejects malformed Foundation durable facts instead of treating them as missing", () => {
		const session = SessionManager.inMemory("/workspace/foundation-malformed");
		const valid = createFoundationFact(session, {
			id: "malformed-fact",
			objectType: "test_fact",
			objectId: "test-object",
			payload: { schemaVersion: 1 },
		});
		const { clientRequestId: _clientRequestId, ...malformed } = valid;
		appendFoundationRecord(session, malformed);

		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(() => coordinator.getRun("missing-run")).toThrow(DurableLedgerError);
		expect(coordinator.diagnostics()).toContainEqual({ kind: "canonical-terminal-invalid" });
	});

	it.each(["sessionId", "laneId", "revision", "fencingToken"] as const)(
		"rejects Foundation %s correlation mismatches",
		(field) => {
			const session = SessionManager.inMemory(`/workspace/foundation-${field}-correlation`);
			const valid = createFoundationFact(session, {
				id: "correlation-fact",
				objectType: "test_fact",
				objectId: "test-object",
				payload: { schemaVersion: 1 },
			});
			appendFoundationRecord(session, {
				...valid,
				correlation: {
					...valid.correlation,
					[field]: field === "revision" ? valid.revision + 1 : `different-${field}`,
				},
			});

			const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
			expect(() => coordinator.getRun("missing-run")).toThrow(DurableLedgerError);
		},
	);

	it.each(["record", "correlation"] as const)("rejects unknown Foundation %s fields", (location) => {
		const session = SessionManager.inMemory(`/workspace/foundation-unknown-${location}`);
		const valid = createFoundationFact(session, {
			id: "unknown-field-fact",
			objectType: "test_fact",
			objectId: "test-object",
			payload: { schemaVersion: 1 },
		});
		appendFoundationRecord(
			session,
			location === "record"
				? { ...valid, unsupported: "value" }
				: { ...valid, correlation: { ...valid.correlation, unsupported: "value" } },
		);

		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(() => coordinator.getRun("missing-run")).toThrow(DurableLedgerError);
	});

	it.each(["id", "seq", "revision"] as const)("rejects duplicate Foundation %s", (field) => {
		const session = SessionManager.inMemory(`/workspace/foundation-duplicate-${field}`);
		const first = appendFoundationFact(session, {
			id: `duplicate-${field}-first`,
			objectType: "test_fact",
			objectId: "test-object",
			payload: { schemaVersion: 1, value: 1 },
		});
		const second = createFoundationFact(session, {
			id: `duplicate-${field}-second`,
			objectType: "test_fact",
			objectId: field === "revision" ? first.objectId : "second-object",
			payload: { schemaVersion: 1, value: 2 },
			revision: 1,
		});
		appendFoundationRecord(session, {
			...second,
			...(field === "id" ? { id: first.id } : {}),
			...(field === "seq" ? { seq: first.seq } : {}),
		});

		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(() => coordinator.getRun("missing-run")).toThrow(DurableLedgerError);
	});

	it("rejects a RunReceipt fact whose source correlation contradicts its payload", () => {
		const session = SessionManager.inMemory("/workspace/foundation-run-correlation");
		appendCanonicalChain(session, "run-correlation", {
			runCorrelation: {
				taskId: "task-run-correlation",
				runId: "different-run",
				runReceiptId: "run-receipt-run-correlation",
				taskResultId: "task-result-run-correlation",
				attemptId: "attempt-run-correlation",
				attemptReceiptId: "attempt-receipt-run-correlation",
			},
		});

		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(() => coordinator.getRun("run-correlation")).toThrow(FoundationError);
	});

	it("rethrows canonical conflicts from live lookup and restart rebuild after recording diagnostics", () => {
		const session = SessionManager.inMemory("/workspace/run-conflict");
		const live = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		live.reserve().accept({ runId: "run-conflict", attempt: 1, model: MODEL }).start();
		appendCanonicalChain(session, "run-conflict", { conflictingDuplicate: true });

		expect(() => live.getRun("run-conflict")).toThrow(FoundationError);
		expect(live.diagnostics()).toContainEqual({ kind: "canonical-terminal-invalid", runId: "run-conflict" });

		const interrupted: string[] = [];
		const restarted = createRunLifecycleCoordinator(session, {
			diagnostics: () => {},
			credentialHooks: { onRunInterrupted: (runId) => interrupted.push(runId) },
		});
		expect(() => restarted.rebuildIndex()).toThrow(FoundationError);
		expect(restarted.diagnostics()).toContainEqual({ kind: "canonical-terminal-invalid" });
		expect(interrupted).toEqual([]);
	});

	it("migrates complete legacy-only evidence without inventing a canonical receipt", () => {
		const session = SessionManager.inMemory("/workspace/legacy-only");
		appendLegacyRun(session, "legacy-only");

		const result = createRunLifecycleCoordinator(session, { diagnostics: () => {} }).getRun("legacy-only");
		expect(result).toMatchObject({
			record: { id: "legacy-only", status: "completed", endedAt: COMPLETED_AT },
		});
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBeUndefined();
	});

	it("keeps equal legacy evidence canonical and fails closed when it conflicts", () => {
		const equalSession = SessionManager.inMemory("/workspace/legacy-equal");
		appendLegacyRun(equalSession, "legacy-equal");
		appendCanonicalChain(equalSession, "legacy-equal");
		const equal = createRunLifecycleCoordinator(equalSession, { diagnostics: () => {} }).getRun("legacy-equal");
		expect(equal?.receipt).toMatchObject({ runReceiptId: "run-receipt-legacy-equal", status: "completed" });

		const conflictSession = SessionManager.inMemory("/workspace/legacy-conflict");
		appendLegacyRun(conflictSession, "legacy-conflict", 4);
		appendCanonicalChain(conflictSession, "legacy-conflict");
		const conflict = createRunLifecycleCoordinator(conflictSession, { diagnostics: () => {} });
		expect(() => conflict.getRun("legacy-conflict")).toThrow(PrivateMigrationError);
		expect(conflict.diagnostics()).toContainEqual({ kind: "canonical-terminal-invalid" });
	});

	it("does not upgrade a legacy terminal that has no started evidence", () => {
		const session = SessionManager.inMemory("/workspace/legacy-missing-started");
		const runId = "legacy-missing-started";
		session.appendCustomEntry("automation.run", {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: runId,
				sessionId: session.getSessionId(),
				attempt: 1,
				status: "accepted",
				model: MODEL,
			},
		});
		session.appendCustomEntry("automation.run", {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: COMPLETED_AT,
			receipt: {
				runId,
				sessionId: session.getSessionId(),
				status: "completed",
				usage: { input: 1, output: 2, total: 3 },
			},
		});

		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(() => coordinator.getRun(runId)).toThrow(PrivateMigrationError);
		expect(coordinator.diagnostics()).toContainEqual({ kind: "canonical-terminal-invalid" });
	});
});
