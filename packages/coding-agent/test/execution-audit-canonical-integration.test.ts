import type {
	Attempt,
	AttemptReceipt,
	ExecutionCorrelation,
	FoundationFactRecord,
	PublicExecutionError,
	ResultStatus,
	RunReceipt,
	SideEffectState,
	TaskEnvelope,
	TaskResult,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	type AuditSession,
	type ExecutionAuditError,
} from "../src/core/execution-audit.ts";
import { ExecutionAuditQuery } from "../src/core/execution-audit-query.ts";
import { FOUNDATION_DURABLE_CUSTOM_TYPE } from "../src/core/session-manager-storage.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const SESSION_ID = "session-canonical-audit";
const LANE_ID = "main";
const BASE_TIME = Date.parse("2026-08-26T01:00:00.000Z");

interface Scenario {
	readonly name: string;
	readonly runStatus: RunReceipt["terminalStatus"];
	readonly resultStatus: ResultStatus;
	readonly sideEffectState: SideEffectState;
	readonly error?: PublicExecutionError;
}

interface CanonicalFixture {
	readonly runId: string;
	readonly entries: ReadonlyArray<SessionEntry>;
	readonly records: ReadonlyArray<FoundationFactRecord>;
}

function physicalEntry(record: FoundationFactRecord, suffix = ""): SessionEntry {
	return {
		type: "custom",
		id: `physical-${record.id}${suffix}`,
		parentId: null,
		timestamp: new Date(record.timestamp).toISOString(),
		customType: FOUNDATION_DURABLE_CUSTOM_TYPE,
		data: { schemaVersion: 1, kind: "durable", record },
	} as SessionEntry;
}

function fact<TValue>(
	objectType: string,
	objectId: string,
	seq: number,
	payload: TValue,
	correlation: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision">,
): FoundationFactRecord {
	const fencingToken = "fence-canonical-audit";
	return {
		schemaVersion: 1,
		kind: "fact",
		id: `foundation-${objectType}-${objectId}`,
		seq,
		lane: LANE_ID,
		timestamp: BASE_TIME + seq * 1_000,
		objectType,
		objectId,
		revision: 1,
		clientRequestId: `${objectType}:${objectId}`,
		fencingToken,
		correlation: {
			sessionId: SESSION_ID,
			laneId: LANE_ID,
			revision: 1,
			fencingToken,
			...correlation,
		},
		payload: payload as unknown as FoundationFactRecord["payload"],
	};
}

function canonicalFixture(scenario: Scenario): CanonicalFixture {
	const suffix = scenario.name;
	const runId = `run-${suffix}`;
	const taskId = `task-${suffix}`;
	const dispatchId = `dispatch-${suffix}`;
	const attemptId = `attempt-${suffix}`;
	const attemptReceiptId = `attempt-receipt-${suffix}`;
	const taskResultId = `task-result-${suffix}`;
	const runReceiptId = `run-receipt-${suffix}`;
	const startedAt = new Date(BASE_TIME + 2_000).toISOString();
	const completedAt = new Date(BASE_TIME + 5_000).toISOString();
	const attemptStatus = scenario.resultStatus === "succeeded"
		? "succeeded"
		: scenario.resultStatus === "cancelled"
			? "cancelled"
			: "failed";
	const task: TaskEnvelope = {
		schemaVersion: 1,
		taskId,
		goalId: `goal-${suffix}`,
		goal: `Execute ${suffix}`,
		kind: "run",
		workspace: "workspace-canonical-audit",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: scenario.resultStatus === "succeeded"
			? "succeeded"
			: scenario.resultStatus === "cancelled"
				? "cancelled"
				: "failed",
		createdAt: new Date(BASE_TIME).toISOString(),
		updatedAt: completedAt,
	};
	const attempt: Attempt = {
		schemaVersion: 1,
		attemptId,
		dispatchId,
		taskId,
		providerId: "scheduler.fixture",
		bindingId: `binding-${suffix}`,
		bindingEpochIds: [`epoch-${suffix}`],
		status: attemptStatus,
		startedAt,
		completedAt,
	};
	const provenanceCorrelation = (extra: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision">): ExecutionCorrelation => ({
		sessionId: SESSION_ID,
		laneId: LANE_ID,
		revision: 1,
		...extra,
	});
	const attemptReceipt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: "scheduler.fixture",
		bindingId: attempt.bindingId,
		bindingEpochIds: attempt.bindingEpochIds,
		status: attemptStatus,
		workerReceiptRefs: [{ schemaVersion: 1, type: "worker_receipt", id: `worker-receipt-${suffix}`, revision: 1 }],
		artifacts: [],
		...(scenario.error === undefined ? {} : { error: scenario.error }),
		provenance: {
			producerKind: "scheduler",
			providerId: "scheduler.fixture",
			producedAt: new Date(BASE_TIME + 3_000).toISOString(),
			correlation: provenanceCorrelation({
				taskId,
				dispatchId,
				attemptId,
				attemptReceiptId,
				bindingId: attempt.bindingId,
				bindingEpochId: attempt.bindingEpochIds[0],
			}),
		},
		sideEffectState: scenario.sideEffectState,
	};
	const taskResult: TaskResult = {
		schemaVersion: 1,
		taskResultId,
		taskId,
		sourceAttemptReceiptIds: [attemptReceiptId],
		status: scenario.resultStatus,
		summary: `Task ${suffix} summary`,
		artifacts: [],
		tests: [],
		evidence: [],
		...(scenario.error === undefined ? {} : { error: scenario.error }),
		provenance: {
			producerKind: "host",
			providerId: "host.fixture",
			producedAt: new Date(BASE_TIME + 4_000).toISOString(),
			correlation: provenanceCorrelation({ taskId, taskResultId }),
		},
		validation: {
			schemaValid: scenario.resultStatus === "succeeded",
			artifactDigestsValid: scenario.resultStatus === "succeeded",
			acceptanceVerified: scenario.resultStatus === "succeeded",
			requiredEvidencePresent: scenario.resultStatus === "succeeded",
		},
	};
	const runReceipt: RunReceipt = {
		schemaVersion: 1,
		runReceiptId,
		runId,
		terminalStatus: scenario.runStatus,
		taskResultId,
		attemptReceiptIds: [attemptReceiptId],
		usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
		...(scenario.error === undefined
			? {}
			: { terminalErrorCode: scenario.error.code, terminalError: scenario.error }),
		completedAt,
	};
	const records = [
		fact("task", taskId, 1, task, { taskId }),
		fact("attempt", attemptId, 2, attempt, { taskId, dispatchId, attemptId, runId }),
		fact("attempt_receipt", attemptReceiptId, 3, attemptReceipt, { taskId, dispatchId, attemptId, attemptReceiptId, runId }),
		fact("task_result", taskResultId, 4, taskResult, { taskId, taskResultId, runId }),
		fact("run_receipt", runId, 5, runReceipt, { taskId, runId, runReceiptId, taskResultId, attemptId, attemptReceiptId }),
	];
	return { runId, records, entries: records.map((record) => physicalEntry(record)) };
}

function auditSession(entries: ReadonlyArray<SessionEntry>, compatibilityEntries: ReadonlyArray<SessionEntry> = []): AuditSession {
	return {
		getSessionId: () => SESSION_ID,
		getEntries: () => compatibilityEntries,
		getPhysicalEntries: () => entries,
	};
}

function legacyTerminalEntries(
	runId: string,
	input: number,
	acceptedAt = new Date(BASE_TIME).toISOString(),
): SessionEntry[] {
	const startedAt = new Date(BASE_TIME + 2_000).toISOString();
	const endedAt = new Date(BASE_TIME + 5_000).toISOString();
	return [
		{
			type: "custom",
			id: `legacy-accepted-${runId}`,
			parentId: null,
			timestamp: acceptedAt,
			customType: "automation.run",
			data: {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: runId,
					sessionId: SESSION_ID,
					attempt: 1,
					status: "accepted",
					model: { provider: "legacy", id: "legacy", thinkingLevel: "off" },
				},
			},
		},
		{
			type: "custom",
			id: `legacy-started-${runId}`,
			parentId: null,
			timestamp: startedAt,
			customType: "automation.run",
			data: { schemaVersion: 1, kind: "started", runId, startedAt },
		},
		{
			type: "custom",
			id: `legacy-terminal-${runId}`,
			parentId: null,
			timestamp: endedAt,
			customType: "automation.run",
			data: {
				schemaVersion: 1,
				kind: "terminal",
				endedAt,
				receipt: {
					runId,
					sessionId: SESSION_ID,
					status: "completed",
					usage: { input, output: 8, total: input + 8 },
				},
			},
		},
	] as SessionEntry[];
}

const scenarios: ReadonlyArray<Scenario> = [
	{ name: "completed", runStatus: "completed", resultStatus: "succeeded", sideEffectState: "none" },
	{
		name: "failed",
		runStatus: "failed",
		resultStatus: "failed",
		sideEffectState: "none",
		error: { code: "agent_run_failed", message: "failed", category: "unknown", retryable: false },
	},
	{
		name: "cancelled",
		runStatus: "cancelled",
		resultStatus: "cancelled",
		sideEffectState: "none",
		error: { code: "user_aborted", message: "cancelled", category: "cancelled", retryable: false },
	},
	{
		name: "deadline",
		runStatus: "failed",
		resultStatus: "failed",
		sideEffectState: "none",
		error: { code: "run_deadline_exceeded", message: "deadline", category: "deadline", retryable: false },
	},
	{
		name: "side-effect-unknown",
		runStatus: "failed",
		resultStatus: "failed",
		sideEffectState: "side_effect_unknown",
		error: { code: "side_effect_unknown", message: "unknown effect", category: "side_effect_unknown", retryable: false },
	},
];

describe("canonical Execution Audit integration", () => {
	it.each(scenarios)("keeps Audit and Replay terminal projection parity for $name", (scenario) => {
		const fixture = canonicalFixture(scenario);
		const adapter = new ExecutionAuditAdapter(auditSession(fixture.entries));
		const replay = adapter.replay(fixture.runId);
		const terminal = replay.events.find((event) => event.type === `run.${scenario.runStatus}`);

		expect(replay.status).toBe("complete");
		expect(replay.run.status).toBe(scenario.runStatus);
		expect(replay.run.usage).toEqual({ input: 21, output: 8, total: 29 });
		expect(replay.run.terminalError).toEqual(
			scenario.error === undefined
				? undefined
				: { code: scenario.error.code, category: scenario.error.category, retryable: scenario.error.retryable },
		);
		expect(terminal?.summary).toEqual(replay.run);
		expect(terminal).toMatchObject({
			eventId: fixture.records.at(-1)!.id,
			sourceEntryId: fixture.records.at(-1)!.id,
			recordedAt: new Date(fixture.records.at(-1)!.timestamp).toISOString(),
		});
		expect(replay.events.find((event) => event.type === "run.accepted")?.recordedAt).toBe(
			new Date(BASE_TIME + 1_000).toISOString(),
		);
		expect(replay.run).not.toHaveProperty("attempt");
		expect(replay.run).not.toHaveProperty("model");
	});

	it("deduplicates out-of-order canonical records and preserves restart cursors", () => {
		const fixture = canonicalFixture(scenarios[0]!);
		const duplicate = physicalEntry(fixture.records[0]!, "-duplicate");
		const firstSession = auditSession([...fixture.entries, duplicate].reverse());
		const restartedSession = auditSession([duplicate, ...fixture.entries]);
		const first = new ExecutionAuditQuery(firstSession, { cursorSecret: "canonical-audit-secret" });
		const restarted = new ExecutionAuditQuery(restartedSession, { cursorSecret: "canonical-audit-secret" });
		const firstPage = first.query({ scope: "current-session", runId: fixture.runId, limit: 1 });
		const restartedPage = restarted.query({ scope: "current-session", runId: fixture.runId, limit: 1 });

		expect(firstPage).toEqual(restartedPage);
		expect(firstPage.nextCursor).toBeDefined();
		expect(first.replay(fixture.runId)).toEqual(restarted.replay(fixture.runId));
	});

	it("fails closed when a duplicate canonical record conflicts", () => {
		const fixture = canonicalFixture(scenarios[0]!);
		const terminal = fixture.records.at(-1)!;
		const conflicting = {
			...terminal,
			payload: {
				...(terminal.payload as unknown as RunReceipt),
				usage: { inputTokens: 99, outputTokens: 8, totalTokens: 107 },
			} as unknown as FoundationFactRecord["payload"],
		};
		const adapter = new ExecutionAuditAdapter(auditSession([
			...fixture.entries,
			physicalEntry(conflicting, "-conflict"),
		]));

		expect(() => adapter.fold()).toThrow(expect.objectContaining<Partial<ExecutionAuditError>>({
			code: "audit_replay_incomplete",
		}));
	});

	it("keeps an equal legacy terminal private behind the canonical projection", () => {
		const fixture = canonicalFixture(scenarios[0]!);
		const canonicalOnly = new ExecutionAuditAdapter(auditSession(fixture.entries)).replay(fixture.runId);
		const reconciled = new ExecutionAuditAdapter(
			auditSession([...fixture.entries, ...legacyTerminalEntries(fixture.runId, 21)]),
		).replay(fixture.runId);

		expect(reconciled).toEqual(canonicalOnly);
		expect(reconciled.run).not.toHaveProperty("attempt");
		expect(reconciled.run).not.toHaveProperty("model");
	});

	it("migrates a legacy-only terminal when its terminal clock precedes the audit append clock", () => {
		const runId = "run-legacy-only";
		const [accepted, , terminal] = legacyTerminalEntries(runId, 21, new Date(BASE_TIME + 6_000).toISOString());
		const replay = new ExecutionAuditAdapter(auditSession([accepted!, terminal!])).replay(runId);

		expect(replay.status).toBe("complete");
		expect(replay.run).toMatchObject({ status: "completed", usage: { input: 21, output: 8, total: 29 } });
		expect(new Set(replay.events.map((event) => event.type))).toEqual(new Set(["run.accepted", "run.completed"]));
	});

	it("fails closed when legacy terminal migration conflicts with the canonical Run", () => {
		const fixture = canonicalFixture(scenarios[0]!);
		const adapter = new ExecutionAuditAdapter(
			auditSession([...fixture.entries, ...legacyTerminalEntries(fixture.runId, 999)]),
		);

		expect(() => adapter.replay(fixture.runId)).toThrow(expect.objectContaining<Partial<ExecutionAuditError>>({
			code: "audit_replay_incomplete",
		}));
	});
});
