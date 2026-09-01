import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditReplayResult, RunGetData } from "../src/modes/rpc/rpc-types.ts";
import {
	RunReplayRecovery,
	RpcClient,
	type RpcRunStreamEvent,
} from "../src/modes/rpc/rpc-client.ts";

const RUN_ID = "r1";
const SESSION_ID = "s1";
const RECEIPT = {
	runId: RUN_ID,
	sessionId: SESSION_ID,
	runReceiptId: "run-receipt-r1",
	attemptReceiptIds: ["attempt-receipt-r1"],
	sideEffectState: "none",
	status: "completed",
	usage: { input: 1, output: 2, total: 3 },
} as const;

function streamEvent(type: "run.started" | "run.completed" | "run.failed" | "run.cancelled", sequence: number): RpcRunStreamEvent {
	const envelope = {
		runId: RUN_ID,
		sessionId: SESSION_ID,
		sequence,
		timestamp: new Date(Date.UTC(2026, 7, 14, 0, 0, sequence)).toISOString(),
		eventId: `run-event-${sequence}`,
		streamId: SESSION_ID,
		correlation: { sessionId: SESSION_ID, laneId: "main", runId: RUN_ID },
	};
	if (type === "run.started") {
		return { type, ...envelope };
	}
	return {
		type,
		...envelope,
		correlation: { ...envelope.correlation, runReceiptId: RECEIPT.runReceiptId },
		receipt: { ...RECEIPT, status: type === "run.failed" ? "failed" : type === "run.cancelled" ? "cancelled" : "completed" },
	};
}

function auditEvent(
	type: "run.accepted" | "run.started" | "run.completed" | "run.failed" | "run.cancelled",
	key: string,
	terminalError?: { readonly code: string; readonly retryable: boolean },
): AuditEvent {
	const status =
		type === "run.accepted"
			? "accepted"
			: type === "run.started"
				? "running"
				: type === "run.failed"
					? "failed"
					: type === "run.cancelled"
						? "cancelled"
						: "completed";
	return {
		schemaVersion: 1,
		eventId: `event-${key}`,
		recordedAt: `2026-08-14T00:00:0${key.length}.000Z`,
		sessionId: SESSION_ID,
		sourceEntryId: `entry-${key}`,
		type,
		runId: RUN_ID,
		summary: {
			status,
			attempt: 1,
			model: { provider: "provider", id: "model", thinkingLevel: "low" },
			...(type === "run.completed" || type === "run.failed" || type === "run.cancelled"
				? { usage: RECEIPT.usage }
				: {}),
			...(terminalError === undefined ? {} : { terminalError }),
		},
	} as AuditEvent;
}

function replayResult(
	events: ReadonlyArray<AuditEvent>,
	status: AuditReplayResult["status"],
	nextCursor?: string,
): AuditReplayResult {
	return {
		schemaVersion: 1,
		run: {
			status: status === "complete" ? "completed" : "running",
			attempt: 1,
			model: { provider: "provider", id: "model", thinkingLevel: "low" },
		},
		events,
		...(nextCursor === undefined ? {} : { nextCursor }),
		status,
		warnings: [],
		integrity: {
			schemaVersion: 1,
			status: "legacy",
			cursorProtection: "injected",
			sessions: [],
		},
	};
}

function runSnapshot(status: "running" | "completed"): RunGetData {
	return {
		run: {
			id: RUN_ID,
			sessionId: SESSION_ID,
			attempt: 1,
			status,
			model: { provider: "provider", id: "model", thinkingLevel: "low" },
		},
		...(status === "completed" ? { receipt: RECEIPT } : {}),
	};
}

describe("RunReplayRecovery live stream alignment", () => {
	it("requires contiguous event sequences and leaves the gap-causing event unconsumed", () => {
		const recovery = new RunReplayRecovery({ runId: RUN_ID });

		expect(recovery.consumeRunEvent(streamEvent("run.started", 1))).toMatchObject({
			disposition: "accepted",
			accepted: true,
		});
		const gap = recovery.consumeRunEvent(streamEvent("run.started", 3));
		expect(gap).toMatchObject({
			disposition: "gap",
			accepted: false,
			gap: { expectedSequence: 2, missingFrom: 2, missingTo: 2 },
		});
		expect(recovery.eventSequence).toBe(1);
		expect(recovery.consumeRunEvent(streamEvent("run.started", 2)).accepted).toBe(true);
		expect(recovery.consumeRunEvent(streamEvent("run.started", 3)).accepted).toBe(true);
	});

	it("deduplicates repeated sequences and confirms terminal state once", () => {
		const recovery = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 1 });
		const terminal = recovery.consumeRunEvent(streamEvent("run.completed", 2));
		expect(terminal).toMatchObject({
			disposition: "accepted",
			terminalConfirmation: { source: "run.event", status: "completed", sequence: 2 },
		});

		const duplicate = recovery.consumeRunEvent(streamEvent("run.completed", 2));
		expect(duplicate).toMatchObject({ disposition: "terminal_duplicate", duplicate: true });
		expect(duplicate.terminalConfirmation).toBeUndefined();
		expect(recovery.terminalConfirmed).toBe(true);
		expect(recovery.consumeRunEvent(streamEvent("run.started", 3)).disposition).toBe("after_terminal");
		expect(recovery.eventSequence).toBe(2);
	});

	it("rejects stream, correlation, and receipt identities that disagree with the envelope", () => {
		const recovery = new RunReplayRecovery({ runId: RUN_ID });
		const started = streamEvent("run.started", 1);
		expect(recovery.consumeRunEvent({ ...started, eventId: "" })).toMatchObject({
			disposition: "ignored",
			ignoredReason: "invalid_envelope",
		});
		expect(recovery.consumeRunEvent({ ...started, streamId: "other-session" })).toMatchObject({
			disposition: "ignored",
			ignoredReason: "correlation_mismatch",
		});
		expect(recovery.consumeRunEvent({
			...started,
			correlation: { ...started.correlation, runId: "other-run" },
		})).toMatchObject({ disposition: "ignored", ignoredReason: "correlation_mismatch" });
		const completed = streamEvent("run.completed", 1);
		if (completed.type !== "run.completed") throw new Error("expected completed event");
		expect(recovery.consumeRunEvent({
			...completed,
			correlation: { sessionId: SESSION_ID, laneId: "main", runId: RUN_ID },
		})).toMatchObject({ disposition: "ignored", ignoredReason: "correlation_mismatch" });
		expect(recovery.consumeRunEvent({
			...completed,
			correlation: { ...completed.correlation, runReceiptId: "other-run-receipt" },
		})).toMatchObject({ disposition: "ignored", ignoredReason: "correlation_mismatch" });
		const missingRunReceiptId = streamEvent("run.completed", 1);
		if (missingRunReceiptId.type !== "run.completed") throw new Error("expected completed event");
		delete (missingRunReceiptId.receipt as unknown as Record<string, unknown>).runReceiptId;
		expect(recovery.consumeRunEvent(missingRunReceiptId)).toMatchObject({
			disposition: "ignored",
			ignoredReason: "correlation_mismatch",
		});
		const conflictingRunReceiptId = streamEvent("run.completed", 1);
		if (conflictingRunReceiptId.type !== "run.completed") throw new Error("expected completed event");
		(conflictingRunReceiptId.receipt as unknown as Record<string, unknown>).runReceiptId = "other-run-receipt";
		expect(recovery.consumeRunEvent(conflictingRunReceiptId)).toMatchObject({
			disposition: "ignored",
			ignoredReason: "correlation_mismatch",
		});
		expect(recovery.consumeRunEvent({
			...completed,
			receipt: { ...completed.receipt, sessionId: "other-session" },
		})).toMatchObject({ disposition: "ignored", ignoredReason: "correlation_mismatch" });
		expect(recovery.eventSequence).toBe(0);
		expect(recovery.terminalConfirmed).toBe(false);

		const runEventRecovery = new RunReplayRecovery({ runId: RUN_ID });
		const runEvent: RpcRunStreamEvent = {
			...started,
			type: "run.event",
			event: { type: "agent_settled" },
		};
		expect(runEventRecovery.consumeRunEvent(runEvent).accepted).toBe(true);
		expect(runEventRecovery.consumeRunEvent({
			...runEvent,
			sequence: 2,
			eventId: "run-event-2",
			correlation: { ...runEvent.correlation, sessionId: "other-session" },
		})).toMatchObject({ disposition: "ignored", ignoredReason: "correlation_mismatch" });
		expect(runEventRecovery.eventSequence).toBe(1);
	});
});

describe("RunReplayRecovery audit cursor alignment", () => {
	it("keeps the audit cursor independent and deduplicates replay identities", () => {
		const accepted = auditEvent("run.accepted", "accepted");
		const completed = auditEvent("run.completed", "completed");
		const recovery = new RunReplayRecovery({ runId: RUN_ID });

		const first = recovery.consumeReplayPage(replayResult([accepted], "interrupted", "cursor-1"));
		expect(first.events).toEqual([accepted]);
		expect(first.state).toMatchObject({ lastEventSequence: 0, auditReplayCursor: "cursor-1", auditReplayComplete: false });

		const second = recovery.consumeReplayPage(replayResult([accepted, completed], "complete"));
		expect(second.events).toEqual([completed]);
		expect(second.duplicateEventKeys).toHaveLength(1);
		expect(second.terminalConfirmation).toMatchObject({ source: "audit.replay", status: "completed" });
		expect(second.state).toMatchObject({
			lastEventSequence: 0,
			auditReplayCursor: "cursor-1",
			auditReplayComplete: true,
			terminal: { source: "audit.replay", status: "completed" },
		});
	});

	it("does not let an audit terminal confirmation duplicate a later live terminal", () => {
		const recovery = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 1 });
		const completed = auditEvent("run.completed", "completed");
		recovery.consumeReplayPage(replayResult([completed], "complete"));

		const live = recovery.consumeRunEvent(streamEvent("run.completed", 2));
		expect(live.disposition).toBe("terminal_duplicate");
		expect(live.terminalConfirmation).toBeUndefined();
		expect(live.state.lastEventSequence).toBe(2);
	});

	it("requires terminal usage and error parity across audit replay and the live timeline", () => {
		const usageRecovery = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 1 });
		usageRecovery.consumeReplayPage(replayResult([auditEvent("run.completed", "completed")], "complete"));
		const liveUsageConflict = streamEvent("run.completed", 2);
		if (liveUsageConflict.type !== "run.completed") throw new Error("expected completed event");
		expect(() => usageRecovery.consumeRunEvent({
			...liveUsageConflict,
			receipt: { ...liveUsageConflict.receipt, usage: { input: 9, output: 2, total: 11 } },
		})).toThrowError(expect.objectContaining({ code: "run_replay_terminal_conflict" }));
		expect(usageRecovery.getState().terminalConflict).toEqual({
			confirmed: "completed",
			received: "completed",
			source: "run.event",
			reason: "usage",
		});
		expect(usageRecovery.getState()).not.toHaveProperty("terminal");
		expect(usageRecovery.terminalConfirmed).toBe(false);
		expect(() => usageRecovery.consumeRunEvent(streamEvent("run.completed", 2))).toThrowError(
			expect.objectContaining({ code: "run_replay_terminal_conflict" }),
		);

		const errorRecovery = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 1 });
		errorRecovery.consumeReplayPage(replayResult([
			auditEvent("run.failed", "failed", { code: "canonical_failure", retryable: false }),
		], "complete"));
		const liveErrorConflict = streamEvent("run.failed", 2);
		if (liveErrorConflict.type !== "run.failed") throw new Error("expected failed event");
		expect(() => errorRecovery.consumeRunEvent({
			...liveErrorConflict,
			receipt: {
				...liveErrorConflict.receipt,
				terminalError: { code: "model_error", message: "different", retryable: false },
			},
		})).toThrowError(expect.objectContaining({ code: "run_replay_terminal_conflict" }));
		expect(errorRecovery.getState()).toMatchObject({ terminalConflict: { reason: "terminal_error" } });
		expect(errorRecovery.getState()).not.toHaveProperty("terminal");

		const statusRecovery = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 1 });
		statusRecovery.consumeReplayPage(replayResult([auditEvent("run.completed", "completed")], "complete"));
		expect(() => statusRecovery.consumeRunEvent(streamEvent("run.failed", 2))).toThrowError(
			expect.objectContaining({ code: "run_replay_terminal_conflict" }),
		);
		expect(statusRecovery.getState()).toMatchObject({ terminalConflict: { reason: "status" } });
		expect(statusRecovery.getState()).not.toHaveProperty("terminal");
	});
});

describe("RpcClient reconnect/replay helper", () => {
	it("fails reconnect closed when run.get and Audit terminal evidence conflict", async () => {
		const recovery = new RunReplayRecovery({
			runId: RUN_ID,
			source: {
				getRun: async () => runSnapshot("completed"),
				auditReplay: async () => replayResult([auditEvent("run.failed", "failed")], "complete"),
			},
		});

		await expect(recovery.reconnect()).rejects.toMatchObject({ code: "run_replay_terminal_conflict" });
		expect(recovery.getState()).toMatchObject({ terminalConflict: { reason: "status" } });
		expect(recovery.getState()).not.toHaveProperty("terminal");
	});

	it("uses only run.get and audit.replay, resumes from the opaque cursor, and aggregates pages", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as {
			send: (command: { type: string; cursor?: string }) => Promise<unknown>;
		};
		const accepted = auditEvent("run.accepted", "accepted");
		const completed = auditEvent("run.completed", "completed");
		const send = vi.fn(async (command: { type: string; cursor?: string }) => {
			if (command.type === "run.get") {
				return { type: "response", command: "run.get", success: true, data: runSnapshot("running") };
			}
			if (command.type === "audit.replay") {
				return command.cursor === undefined
					? { type: "response", command: "audit.replay", success: true, data: replayResult([accepted], "interrupted", "cursor-1") }
					: { type: "response", command: "audit.replay", success: true, data: replayResult([accepted, completed], "complete") };
			}
			throw new Error(`unexpected command ${command.type}`);
		});
		privateClient.send = send;

		const result = await client.reconnectRun(RUN_ID, { replayQuery: { scope: "current-session", limit: 1 } });

		expect(result.pages).toBe(2);
		expect(result.events.map((event) => event.type)).toEqual(["run.accepted", "run.completed"]);
		expect(result.duplicateEventKeys).toHaveLength(1);
		expect(result.state.auditReplayComplete).toBe(true);
		expect(result.state.lastEventSequence).toBe(0);
		expect(result.terminalConfirmation).toMatchObject({ source: "audit.replay", status: "completed" });
		expect(send).toHaveBeenNthCalledWith(1, { type: "run.get", runId: RUN_ID });
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "audit.replay",
			runId: RUN_ID,
			scope: "current-session",
			limit: 1,
		});
		expect(send).toHaveBeenNthCalledWith(3, {
			type: "audit.replay",
			runId: RUN_ID,
			scope: "current-session",
			limit: 1,
			cursor: "cursor-1",
		});
	});

	it("restores a checkpoint without conflating its sequence and cursor", () => {
		const first = new RunReplayRecovery({ runId: RUN_ID, initialEventSequence: 4, replayQuery: { limit: 5 } });
		const state = first.getState();
		const resumed = new RunReplayRecovery({ runId: RUN_ID, state, replayQuery: { limit: 5 } });

		expect(resumed.eventSequence).toBe(4);
		expect(resumed.auditCursor).toBeUndefined();
		expect(resumed.nextEventSequence).toBe(5);
	});
});
