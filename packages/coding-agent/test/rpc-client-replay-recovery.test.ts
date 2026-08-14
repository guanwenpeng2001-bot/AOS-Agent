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
	status: "completed",
	usage: { input: 1, output: 2, total: 3 },
} as const;

function streamEvent(type: "run.started" | "run.completed" | "run.failed" | "run.cancelled", sequence: number): RpcRunStreamEvent {
	if (type === "run.started") {
		return { type, runId: RUN_ID, sessionId: SESSION_ID, sequence, timestamp: `t${sequence}` };
	}
	return {
		type,
		runId: RUN_ID,
		sessionId: SESSION_ID,
		sequence,
		timestamp: `t${sequence}`,
		receipt: { ...RECEIPT, status: type === "run.failed" ? "failed" : type === "run.cancelled" ? "cancelled" : "completed" },
	};
}

function auditEvent(
	type: "run.accepted" | "run.started" | "run.completed" | "run.failed" | "run.cancelled",
	key: string,
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
});

describe("RpcClient reconnect/replay helper", () => {
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
