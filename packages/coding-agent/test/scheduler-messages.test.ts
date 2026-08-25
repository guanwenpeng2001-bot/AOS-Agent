import {
	FoundationError,
	fingerprintFoundationValue,
	type RunReceipt,
	Session,
	SessionLedger,
	type TaskResult,
} from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import { createRunLifecycleCoordinator, type RunLifecycleCoordinator } from "../src/core/run-lifecycle.ts";
import type { SchedulerMessageV1 } from "../src/core/scheduler.ts";
import {
	SCHEDULER_MESSAGE_OBJECT_TYPES_V1,
	type SchedulerMessageMaterialV1,
	SchedulerMessageOrchestrator,
	type SchedulerMessageSessionEndpointV1,
	type SchedulerResultReferenceV1,
} from "../src/core/scheduler-messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionManagerStorage } from "../src/core/session-manager-storage.ts";
import { createTaskGraphStore, type TaskGraphStore } from "../src/core/task-graph.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";

vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => {
		throw new Error("streamSimple is not exercised by scheduler messages");
	},
}));

vi.mock("@aos-agent/ai/providers/all", () => ({}));

const T0 = "2027-01-01T00:00:00.000Z";
const T1 = "2027-01-01T00:01:00.000Z";
const T2 = "2027-01-01T00:02:00.000Z";
const T3 = "2027-01-01T00:03:00.000Z";

interface PairFixture {
	readonly sourceManager: SessionManager;
	readonly targetManager: SessionManager;
	readonly sourceSession: Session;
	readonly targetSession: Session;
	readonly sourceRuns: RunLifecycleCoordinator;
	readonly targetRuns: RunLifecycleCoordinator;
	readonly sourceGraph: TaskGraphStore;
	readonly targetGraph: TaskGraphStore;
	readonly endpoints: readonly [SchedulerMessageSessionEndpointV1, SchedulerMessageSessionEndpointV1];
	readonly messages: SchedulerMessageOrchestrator;
}

function graphStore(manager: SessionManager, runs: RunLifecycleCoordinator): TaskGraphStore {
	return createTaskGraphStore(
		manager,
		{
			get: (runId) => {
				const result = runs.getRun(runId);
				if (result === undefined) return undefined;
				return {
					sessionId: result.record.sessionId,
					runId: result.record.id,
					status: result.record.status,
					...(result.receipt === undefined ? {} : { receiptStatus: result.receipt.status }),
				};
			},
		},
		{ getByBusinessKey: () => undefined },
		{ now: () => T0 },
	);
}

function pair(): PairFixture {
	const sourceManager = SessionManager.inMemory("C:/workspace/source", { id: "session-source" });
	const targetManager = SessionManager.inMemory("C:/workspace/target", { id: "session-target" });
	const sourceSession = new Session(createSessionManagerStorage(sourceManager));
	const targetSession = new Session(createSessionManagerStorage(targetManager));
	const sourceRuns = createRunLifecycleCoordinator(sourceManager, { diagnostics: () => {}, now: () => T0 });
	const targetRuns = createRunLifecycleCoordinator(targetManager, { diagnostics: () => {}, now: () => T0 });
	const sourceGraph = graphStore(sourceManager, sourceRuns);
	const targetGraph = graphStore(targetManager, targetRuns);
	const endpoints = [
		{ session: sourceSession, taskGraph: sourceGraph },
		{ session: targetSession, taskGraph: targetGraph },
	] as const;
	return {
		sourceManager,
		targetManager,
		sourceSession,
		targetSession,
		sourceRuns,
		targetRuns,
		sourceGraph,
		targetGraph,
		endpoints,
		messages: new SchedulerMessageOrchestrator(endpoints),
	};
}

function requiredMessage(overrides: Partial<SchedulerMessageV1> = {}): SchedulerMessageV1 {
	return {
		schemaVersion: 1,
		messageId: "message-1",
		type: "note",
		threadId: "thread-1",
		fromSessionId: "session-source",
		toSessionId: "session-target",
		correlation: { taskId: "task-1" },
		ack: "required",
		expiresAt: T1,
		createdAt: T0,
		revision: 0,
		...overrides,
	};
}

async function expectFoundationCode(action: () => Promise<unknown>, code: string): Promise<void> {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(FoundationError);
		expect((error as FoundationError).code).toBe(code);
		return;
	}
	throw new Error(`Expected FoundationError ${code}`);
}

async function settleGraphNode(
	graph: TaskGraphStore,
	runs: RunLifecycleCoordinator,
	manager: SessionManager,
	input: {
		readonly taskId: string;
		readonly nodeId: string;
		readonly runId: string;
		readonly terminal: "failed" | "cancelled";
	},
): Promise<void> {
	const run = runs.reserve().accept({
		runId: input.runId,
		attempt: 1,
		model: { provider: "test", id: "model", thinkingLevel: "off" },
	});
	graph.attach({
		taskId: input.taskId,
		graphRevision: 1,
		nodeId: input.nodeId,
		runId: input.runId,
		clientRequestId: `attach-${input.runId}`,
	});
	run.start();
	if (input.terminal === "cancelled") run.requestCancel();
	await observeCanonicalTerminal(manager, run, { outcome: input.terminal });
	graph.settle({
		taskId: input.taskId,
		graphRevision: 1,
		nodeId: input.nodeId,
		clientRequestId: `settle-${input.runId}`,
	});
}

async function seedTaskResult(
	session: Session,
	input: { readonly taskResultId: string; readonly taskId: string; readonly status: TaskResult["status"] },
): Promise<SchedulerResultReferenceV1> {
	const result: TaskResult = {
		schemaVersion: 1,
		taskResultId: input.taskResultId,
		taskId: input.taskId,
		sourceAttemptReceiptIds: ["attempt-receipt-1"],
		status: input.status,
		summary: "Host-settled result",
		artifacts: [],
		tests: [],
		evidence: [],
		provenance: {
			producerKind: "host",
			providerId: "host-gate",
			producedAt: T0,
			correlation: {
				sessionId: "session-target",
				laneId: "main",
				taskId: input.taskId,
				taskResultId: input.taskResultId,
				revision: 0,
			},
		},
		validation: {
			schemaValid: true,
			artifactDigestsValid: true,
			acceptanceVerified: input.status !== "succeeded",
			requiredEvidencePresent: input.status !== "succeeded",
		},
	};
	const ledger = new SessionLedger(session, { ownerId: "foundation-t7" });
	const stored = await ledger.appendFact("task_result", input.taskResultId, result, {
		clientRequestId: `seed-task-result-${input.taskResultId}`,
		expectedRevision: 0,
		correlation: { taskId: input.taskId, taskResultId: input.taskResultId },
	});
	return {
		schemaVersion: 1,
		type: "task_result",
		sessionId: "session-target",
		id: input.taskResultId,
		revision: stored.record.revision,
	};
}

async function seedRunReceipt(
	session: Session,
	input: {
		readonly runReceiptId: string;
		readonly runId: string;
		readonly taskId: string;
		readonly status: RunReceipt["terminalStatus"];
	},
): Promise<SchedulerResultReferenceV1> {
	const receipt: RunReceipt = {
		schemaVersion: 1,
		runReceiptId: input.runReceiptId,
		runId: input.runId,
		terminalStatus: input.status,
		...(input.status === "completed" ? { taskResultId: `task-result-${input.taskId}` } : {}),
		attemptReceiptIds: ["attempt-receipt-1"],
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		...(input.status === "completed"
			? {}
			: {
					terminalErrorCode: input.status === "cancelled" ? "run_cancelled" : "run_failed",
					terminalError: {
						code: input.status === "cancelled" ? "run_cancelled" : "run_failed",
						message: input.status,
						category: input.status === "cancelled" ? "cancelled" as const : "unknown" as const,
						retryable: false,
					},
				}),
		completedAt: T0,
	};
	const ledger = new SessionLedger(session, { ownerId: "foundation-t7" });
	const stored = await ledger.appendFact("run_receipt", input.runId, receipt, {
		clientRequestId: `seed-run-receipt-${input.runReceiptId}`,
		expectedRevision: 0,
		correlation: { taskId: input.taskId, runId: input.runId, runReceiptId: input.runReceiptId },
	});
	return {
		schemaVersion: 1,
		type: "run_receipt",
		sessionId: "session-target",
		id: input.runReceiptId,
		runId: input.runId,
		revision: stored.record.revision,
	};
}

async function schedulerPayloads(session: Session): Promise<unknown[]> {
	return (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst", includePruned: true })).flatMap(
		(record) =>
			record.kind === "fact" && record.objectType.startsWith("scheduler.message_") ? [record.payload] : [],
	);
}

describe("durable scheduler message lifecycle", () => {
	it("posts idempotently, acknowledges, replays once, times out, and rebuilds the exact thread after reload", async () => {
		const fixture = pair();
		const posted = await fixture.messages.post({ message: requiredMessage() });
		const duplicate = await fixture.messages.post({ message: requiredMessage() });
		expect(posted.replayed).toBe(false);
		expect(duplicate.replayed).toBe(true);

		const acknowledged = await fixture.messages.acknowledge({
			sessionId: "session-target",
			messageId: "message-1",
			threadId: "thread-1",
			at: T0,
		});
		expect(acknowledged.message).toMatchObject({ revision: 1, ackedAt: T0 });

		await fixture.messages.post({
			message: requiredMessage({ messageId: "message-2", createdAt: T0, expiresAt: T1 }),
		});
		const replayed = await fixture.messages.replayRequiredMessage({
			sessionId: "session-source",
			messageId: "message-2",
			threadId: "thread-1",
			at: T1,
			expiresAt: T2,
		});
		expect(replayed.message).toMatchObject({ revision: 1, createdAt: T1, expiresAt: T2 });
		expect(
			await fixture.messages.replayRequiredMessage({
				sessionId: "session-source",
				messageId: "message-2",
				threadId: "thread-1",
				at: T1,
				expiresAt: T2,
			}),
		).toEqual({ message: replayed.message, replayed: true });
		await expectFoundationCode(
			() =>
				fixture.messages.replayRequiredMessage({
					sessionId: "session-source",
					messageId: "message-2",
					threadId: "thread-1",
					at: T2,
					expiresAt: T3,
				}),
			"scheduler_message_timeout",
		);
		const timedOut = await fixture.messages.timeoutRequiredMessage({
			sessionId: "session-source",
			messageId: "message-2",
			threadId: "thread-1",
			at: T2,
		});
		expect(timedOut).toMatchObject({ revision: 2, timedOutAt: T2 });

		const expected = {
			schemaVersion: 1,
			threadId: "thread-1",
			entries: [
				{
					schemaVersion: 1,
					messageId: "message-1",
					state: "acked",
					message: acknowledged.message,
					transmissions: [requiredMessage()],
				},
				{
					schemaVersion: 1,
					messageId: "message-2",
					state: "timed_out",
					message: replayed.message,
					transmissions: [requiredMessage({ messageId: "message-2" }), replayed.message],
					timeout: timedOut,
				},
			],
		};
		expect(await fixture.messages.rebuildThread("thread-1")).toEqual(expected);

		const reloaded = new SchedulerMessageOrchestrator(fixture.endpoints);
		expect(await reloaded.rebuildThread("thread-1")).toEqual(expected);
	});

	it("rejects forbidden bodies, credentials, tokens, raw paths, unsafe material, and wrong acknowledgment correlation", async () => {
		const fixture = pair();
		await expectFoundationCode(
			() => fixture.messages.post({ message: requiredMessage(), body: "raw" }),
			"scheduler_message_invalid",
		);
		await expectFoundationCode(
			() => fixture.messages.post({ message: requiredMessage(), credentials: { token: "secret" } }),
			"scheduler_message_invalid",
		);
		const artifact: SchedulerMessageMaterialV1 = {
			schemaVersion: 1,
			kind: "artifact",
			sessionId: "session-source",
			artifact: {
				schemaVersion: 1,
				artifactId: "C:/private/token.txt",
				mediaType: "text/plain",
				digest: `sha256:${"a".repeat(64)}`,
			},
		};
		await expectFoundationCode(
			() =>
				fixture.messages.post({
					message: requiredMessage({ payloadDigest: fingerprintFoundationValue(artifact) }),
					material: artifact,
				}),
			"scheduler_message_invalid",
		);
		await fixture.messages.post({ message: requiredMessage() });
		await expectFoundationCode(
			() =>
				fixture.messages.acknowledge({
					sessionId: "session-source",
					messageId: "message-1",
					threadId: "thread-1",
					at: T0,
				}),
			"scheduler_message_invalid",
		);
	});

	it("rejects durable revision gaps instead of guessing a missing transmission", async () => {
		const fixture = pair();
		await fixture.messages.post({ message: requiredMessage() });
		const ledger = new SessionLedger(fixture.sourceSession, { ownerId: "foundation-t7" });
		await ledger.appendFact(
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
			"message-1",
			{ schemaVersion: 1, message: requiredMessage({ revision: 2, createdAt: T2, expiresAt: T3 }) },
			{
				clientRequestId: "inject-revision-gap",
				expectedRevision: 1,
				correlation: { taskId: "task-1", parentId: "message-1" },
			},
		);
		await expectFoundationCode(() => fixture.messages.rebuildThread("thread-1"), "scheduler_message_invalid");
	});
});

describe("cross-Session task submit and wait", () => {
	it("creates or reuses only the target Graph and observes failed, cancelled, and timed-out nodes", async () => {
		const fixture = pair();
		const submit = (taskId: string, suffix: string, expiresAt = T3) =>
			fixture.messages.submitCrossSessionTask({
				sourceSessionId: "session-source",
				targetSessionId: "session-target",
				taskId,
				graphRevision: 1,
				nodeId: "work",
				waitId: `wait-${suffix}`,
				threadId: `thread-${suffix}`,
				messageId: `submit-${suffix}`,
				clientRequestId: `create-${suffix}`,
				createdAt: T0,
				expiresAt,
			});

		const first = await submit("task-failed", "failed");
		const replay = await submit("task-failed", "failed");
		expect(first.reused).toBe(false);
		expect(replay.reused).toBe(true);
		expect(fixture.sourceGraph.get("task-failed", 1)).toBeUndefined();
		expect(fixture.targetGraph.get("task-failed", 1)?.nodes[0]?.status).toBe("pending");
		await settleGraphNode(fixture.targetGraph, fixture.targetRuns, fixture.targetManager, {
			taskId: "task-failed",
			nodeId: "work",
			runId: "run-failed",
			terminal: "failed",
		});
		expect(
			await fixture.messages.waitForCrossSessionTask({
				sourceSessionId: "session-source",
				waitId: "wait-failed",
				at: T1,
			}),
		).toMatchObject({ status: "failed", targetSessionId: "session-target" });

		await submit("task-cancelled", "cancelled");
		await settleGraphNode(fixture.targetGraph, fixture.targetRuns, fixture.targetManager, {
			taskId: "task-cancelled",
			nodeId: "work",
			runId: "run-cancelled",
			terminal: "cancelled",
		});
		expect(
			await fixture.messages.waitForCrossSessionTask({
				sourceSessionId: "session-source",
				waitId: "wait-cancelled",
				at: T1,
			}),
		).toMatchObject({ status: "cancelled" });

		await submit("task-timeout", "timeout", T1);
		expect(
			await fixture.messages.waitForCrossSessionTask({
				sourceSessionId: "session-source",
				waitId: "wait-timeout",
				at: T1,
			}),
		).toMatchObject({ status: "timed_out" });
	});

	it("rejects a wait owned by another source Session", async () => {
		const fixture = pair();
		await fixture.messages.submitCrossSessionTask({
			sourceSessionId: "session-source",
			targetSessionId: "session-target",
			taskId: "task-1",
			graphRevision: 1,
			nodeId: "work",
			waitId: "wait-1",
			threadId: "thread-1",
			messageId: "submit-1",
			clientRequestId: "create-1",
			createdAt: T0,
			expiresAt: T2,
		});
		await expectFoundationCode(
			() =>
				fixture.messages.waitForCrossSessionTask({ sourceSessionId: "session-target", waitId: "wait-1", at: T1 }),
			"scheduler_not_found",
		);
	});
});

describe("result ready and reclaim", () => {
	it("validates owning-Session references, reclaims once, and never copies or writes result objects", async () => {
		const fixture = pair();
		const reference = await seedTaskResult(fixture.targetSession, {
			taskResultId: "task-result-1",
			taskId: "task-1",
			status: "failed",
		});
		const taskResultsBefore = await fixture.targetSession.findFoundationRecords({
			kind: "fact",
			objectType: "task_result",
		});
		const runReceiptsBefore = await fixture.targetSession.findFoundationRecords({
			kind: "fact",
			objectType: "run_receipt",
		});
		const ready = await fixture.messages.publishResultReady({
			ownerSessionId: "session-target",
			consumerSessionId: "session-source",
			taskId: "task-1",
			threadId: "result-thread",
			messageId: "result-ready-1",
			createdAt: T0,
			expiresAt: T2,
			reference,
		});
		expect(ready.type).toBe("result.ready");
		const reclaimed = await fixture.messages.reclaimResult({
			sourceSessionId: "session-source",
			targetSessionId: "session-target",
			taskId: "task-1",
			threadId: "result-thread",
			readyMessageId: "result-ready-1",
			reclaimMessageId: "result-reclaim-1",
			clientRequestId: "reclaim-1",
			at: T1,
		});
		expect(reclaimed).toMatchObject({ reference, status: "failed", replayed: false });
		expect(reclaimed).not.toHaveProperty("summary");
		expect(
			await fixture.messages.reclaimResult({
				sourceSessionId: "session-source",
				targetSessionId: "session-target",
				taskId: "task-1",
				threadId: "result-thread",
				readyMessageId: "result-ready-1",
				reclaimMessageId: "result-reclaim-1",
				clientRequestId: "reclaim-1",
				at: T1,
			}),
		).toMatchObject({ replayed: true, reference });
		await expectFoundationCode(
			() =>
				fixture.messages.reclaimResult({
					sourceSessionId: "session-source",
					targetSessionId: "session-target",
					taskId: "task-1",
					threadId: "result-thread",
					readyMessageId: "result-ready-1",
					reclaimMessageId: "result-reclaim-2",
					clientRequestId: "reclaim-2",
					at: T1,
				}),
			"scheduler_message_invalid",
		);
		expect(
			await fixture.targetSession.findFoundationRecords({ kind: "fact", objectType: "task_result" }),
		).toHaveLength(taskResultsBefore.length);
		expect(
			await fixture.targetSession.findFoundationRecords({ kind: "fact", objectType: "run_receipt" }),
		).toHaveLength(runReceiptsBefore.length);
		expect(
			await fixture.sourceSession.findFoundationRecords({ kind: "fact", objectType: "task_result" }),
		).toHaveLength(0);
		expect(
			await fixture.sourceSession.findFoundationRecords({ kind: "fact", objectType: "run_receipt" }),
		).toHaveLength(0);
	});

	it("returns cancelled RunReceipt status and rejects wrong Session, ref revision, task correlation, and timeout", async () => {
		const fixture = pair();
		const runReference = await seedRunReceipt(fixture.targetSession, {
			runReceiptId: "run-receipt-1",
			runId: "run-1",
			taskId: "task-1",
			status: "cancelled",
		});
		await fixture.messages.publishResultReady({
			ownerSessionId: "session-target",
			consumerSessionId: "session-source",
			taskId: "task-1",
			threadId: "run-result-thread",
			messageId: "run-result-ready",
			createdAt: T0,
			expiresAt: T2,
			reference: runReference,
		});
		expect(
			await fixture.messages.reclaimResult({
				sourceSessionId: "session-source",
				targetSessionId: "session-target",
				taskId: "task-1",
				threadId: "run-result-thread",
				readyMessageId: "run-result-ready",
				reclaimMessageId: "run-result-reclaim",
				clientRequestId: "run-reclaim-1",
				at: T1,
			}),
		).toMatchObject({ status: "cancelled" });

		for (const reference of [
			{ ...runReference, sessionId: "session-source" },
			{ ...runReference, revision: 99 },
		]) {
			await expectFoundationCode(
				() =>
					fixture.messages.publishResultReady({
						ownerSessionId: "session-target",
						consumerSessionId: "session-source",
						taskId: "task-1",
						threadId: "bad-thread",
						messageId: `bad-ready-${reference.revision}`,
						createdAt: T0,
						expiresAt: T1,
						reference,
					}),
				"scheduler_message_invalid",
			);
		}
		await expectFoundationCode(
			() =>
				fixture.messages.publishResultReady({
					ownerSessionId: "session-target",
					consumerSessionId: "session-source",
					taskId: "task-other",
					threadId: "bad-task-thread",
					messageId: "bad-task-ready",
					createdAt: T0,
					expiresAt: T1,
					reference: runReference,
				}),
			"scheduler_message_invalid",
		);

		const expiringReference = await seedTaskResult(fixture.targetSession, {
			taskResultId: "task-result-expiring",
			taskId: "task-expiring",
			status: "failed",
		});
		await fixture.messages.publishResultReady({
			ownerSessionId: "session-target",
			consumerSessionId: "session-source",
			taskId: "task-expiring",
			threadId: "expiring-thread",
			messageId: "expiring-ready",
			createdAt: T0,
			expiresAt: T1,
			reference: expiringReference,
		});
		await expectFoundationCode(
			() =>
				fixture.messages.reclaimResult({
					sourceSessionId: "session-source",
					targetSessionId: "session-target",
					taskId: "task-expiring",
					threadId: "expiring-thread",
					readyMessageId: "expiring-ready",
					reclaimMessageId: "expired-reclaim",
					clientRequestId: "expired-reclaim",
					at: T1,
				}),
			"scheduler_message_timeout",
		);
	});
});

describe("cross-Session Ask orchestration", () => {
	function askInput(suffix: string, dueAt: string, escalationAt?: string) {
		return {
			sourceSessionId: "session-source",
			targetSessionId: "session-target",
			askId: `ask-${suffix}`,
			waitId: `ask-wait-${suffix}`,
			threadId: `ask-thread-${suffix}`,
			messageId: `ask-message-${suffix}`,
			question: `Choose ${suffix}`,
			options: ["approve", "reject"],
			dueAt,
			...(escalationAt === undefined ? {} : { escalationAt, escalationTarget: "operator-1" }),
			createdAt: T0,
			clientRequestId: `ask-create-${suffix}`,
		};
	}

	it("handles answer, expiry, and escalation through AskStore transitions and emits safe acceptance evidence", async () => {
		const fixture = pair();
		const answered = await fixture.messages.createCrossSessionAsk(askInput("answered", T2));
		expect(answered.ask).not.toHaveProperty("question");
		expect(answered.ask).not.toHaveProperty("options");
		await fixture.messages.replyCrossSessionAsk({
			targetSessionId: "session-target",
			askId: answered.ask.askId,
			optionIndex: 0,
			by: "operator-1",
			replyId: "reply-answered",
			clientRequestId: "reply-request-answered",
		});
		const answerResolution = await fixture.messages.resolveCrossSessionAsk({
			sourceSessionId: "session-source",
			waitId: "ask-wait-answered",
			at: T1,
			clientRequestId: "resolve-answered",
			messageId: "ask-response-answered",
		});
		expect(answerResolution).toMatchObject({
			status: "answered",
			evidence: { schemaVersion: 1, outcome: "satisfied", verified: true, recordedBy: "scheduler" },
		});
		expect(answerResolution.evidence).not.toHaveProperty("statement");
		expect(
			await fixture.messages.resolveCrossSessionAsk({
				sourceSessionId: "session-source",
				waitId: "ask-wait-answered",
				at: T2,
				clientRequestId: "resolve-answered-replay",
				messageId: "ask-response-answered",
			}),
		).toEqual(answerResolution);
		await expectFoundationCode(
			() =>
				fixture.messages.resolveCrossSessionAsk({
					sourceSessionId: "session-source",
					waitId: "ask-wait-answered",
					at: T2,
					clientRequestId: "resolve-answered-conflict",
					messageId: "ask-response-conflict",
				}),
			"scheduler_message_invalid",
		);

		await fixture.messages.createCrossSessionAsk(askInput("expired", T1, T3));
		expect(
			await fixture.messages.resolveCrossSessionAsk({
				sourceSessionId: "session-source",
				waitId: "ask-wait-expired",
				at: T1,
				clientRequestId: "resolve-expired",
				messageId: "ask-response-expired",
			}),
		).toMatchObject({ status: "expired", evidence: { outcome: "unsatisfied", verified: false } });

		await fixture.messages.createCrossSessionAsk(askInput("escalated", T3, T1));
		expect(
			await fixture.messages.resolveCrossSessionAsk({
				sourceSessionId: "session-source",
				waitId: "ask-wait-escalated",
				at: T1,
				clientRequestId: "resolve-escalated",
				messageId: "ask-response-escalated",
			}),
		).toMatchObject({ status: "escalated", evidence: { outcome: "pending", verified: false } });

		const schedulerFacts = JSON.stringify([
			...(await schedulerPayloads(fixture.sourceSession)),
			...(await schedulerPayloads(fixture.targetSession)),
		]);
		expect(schedulerFacts).not.toContain("Choose answered");
		expect(schedulerFacts).not.toContain("approve");
		expect(schedulerFacts).not.toContain("reply-answered");
		expect(schedulerFacts).not.toContain("optionIndex");
	});

	it("recovers an answered Ask from the same two ledgers and rejects a wrong source Session", async () => {
		const fixture = pair();
		const created = await fixture.messages.createCrossSessionAsk(askInput("reload", T2));
		await fixture.messages.replyCrossSessionAsk({
			targetSessionId: "session-target",
			askId: created.ask.askId,
			optionIndex: 1,
			by: "operator-1",
			replyId: "reply-reload",
			clientRequestId: "reply-request-reload",
		});
		const reloaded = new SchedulerMessageOrchestrator(fixture.endpoints);
		expect(
			await reloaded.resolveCrossSessionAsk({
				sourceSessionId: "session-source",
				waitId: "ask-wait-reload",
				at: T1,
				clientRequestId: "resolve-reload",
				messageId: "ask-response-reload",
			}),
		).toMatchObject({ status: "answered", evidence: { outcome: "satisfied" } });
		await expectFoundationCode(
			() =>
				reloaded.resolveCrossSessionAsk({
					sourceSessionId: "session-target",
					waitId: "ask-wait-reload",
					at: T1,
					clientRequestId: "resolve-wrong-session",
					messageId: "ask-response-wrong-session",
				}),
			"scheduler_not_found",
		);
	});
});
