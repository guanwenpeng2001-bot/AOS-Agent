import { InMemorySessionStorage, Session, SessionLedgerV1 } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	SUBAGENT_MAILBOX_ACK_OBJECT_TYPE,
	SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
	SubagentMailboxV1,
	type ChildMailboxEndpointV1,
	type SendChildMailboxMessageInputV1,
} from "../src/core/subagent-mailbox.ts";
import type { ChildAgentRosterEntryV1 } from "../src/core/subagent-supervisor.ts";

const START = Date.parse("2026-01-01T00:00:00.000Z");

function child(
	id: string,
	laneId: string,
	status: ChildAgentRosterEntryV1["status"] = "running",
): ChildAgentRosterEntryV1 {
	return {
		schemaVersion: 1,
		sessionId: "session-mailbox",
		laneId,
		childAgentInstanceId: id,
		parentAgentInstanceId: "parent-1",
		ancestorIds: ["parent-1"],
		depth: 1,
		taskId: `task-${id}`,
		attemptId: `attempt-${id}`,
		providerId: "native.in_process",
		providerKind: "in_process",
		status,
		mailboxAddress: id,
	};
}

const parentEndpoint: ChildMailboxEndpointV1 = {
	schemaVersion: 1,
	sessionId: "session-mailbox",
	laneId: "parent-lane",
	agentInstanceId: "parent-1",
	taskId: "task-parent",
	attemptId: "attempt-parent",
};

interface Fixture {
	readonly mailbox: SubagentMailboxV1;
	readonly ledger: SessionLedgerV1;
	readonly ledgerForLane: (laneId: string) => SessionLedgerV1;
	readonly roster: ChildAgentRosterEntryV1[];
	readonly delayCalls: number[];
	readonly setNow: (milliseconds: number) => void;
}

function fixture(
		overrides: {
		roster?: ChildAgentRosterEntryV1[];
		endpoints?: ChildMailboxEndpointV1[];
		session?: Session;
		laneId?: string;
		now?: () => string;
		maxBodyBytes?: number;
		maxPendingPerRecipient?: number;
		maxMessagesPerWindow?: number;
	} = {},
): Fixture {
	const session = overrides.session ?? new Session(new InMemorySessionStorage({ id: "session-mailbox", createdAt: 1 }));
	const ledgers = new Map<string, SessionLedgerV1>();
	const ledgerForLane = (laneId: string): SessionLedgerV1 => {
		let ledger = ledgers.get(laneId);
		if (ledger === undefined) {
			ledger = new SessionLedgerV1(session, { ownerId: "mailbox-writer", laneId });
			ledgers.set(laneId, ledger);
		}
		return ledger;
	};
	const roster = overrides.roster ?? [child("child-1", "child-lane-1"), child("child-2", "child-lane-2")];
	const endpoints = overrides.endpoints ?? [parentEndpoint];
	const laneId = overrides.laneId ?? endpoints[0]?.laneId ?? "parent-lane";
	let milliseconds = START;
	const delayCalls: number[] = [];
	const mailbox = new SubagentMailboxV1({
		schemaVersion: 1,
		ledger: ledgerForLane(laneId),
		ledgerForLane,
		sessionId: "session-mailbox",
		laneId,
		roster: () => roster,
		endpoints,
		maxBodyBytes: overrides.maxBodyBytes ?? 1024,
		maxPendingPerRecipient: overrides.maxPendingPerRecipient ?? 3,
		maxMessagesPerWindow: overrides.maxMessagesPerWindow ?? 4,
		rateWindowMs: 100,
		maxWaitMs: 50,
		pollIntervalMs: 10,
		now: overrides.now ?? (() => new Date(milliseconds).toISOString()),
		clock: () => milliseconds,
		delay: async (duration) => {
			delayCalls.push(duration);
			milliseconds += duration;
		},
	});
	return {
		mailbox,
		ledger: ledgerForLane(laneId),
		ledgerForLane,
		roster,
		delayCalls,
		setNow: (value) => {
			milliseconds = value;
		},
	};
}

function sendInput(
	messageId: string,
	to = child("child-1", "child-lane-1"),
	overrides: Partial<SendChildMailboxMessageInputV1> = {},
): SendChildMailboxMessageInputV1 {
	return {
		schemaVersion: 1,
		messageId,
		fromAgentInstanceId: "parent-1",
		fromAttemptId: "attempt-parent",
		toAgentInstanceId: to.childAgentInstanceId,
		kind: "input",
		body: { text: messageId },
		correlation: {
			sessionId: to.sessionId,
			laneId: to.laneId,
			taskId: to.taskId,
			attemptId: to.attemptId,
			agentInstanceId: to.childAgentInstanceId,
		},
		...overrides,
	};
}

describe("SubagentMailboxV1", () => {
	it("persists ordered messages and acknowledgements on distinct child lanes across reload", async () => {
		const value = fixture();
		expect((await value.mailbox.send(sendInput("message-1"))).ok).toBe(true);
		expect((await value.mailbox.send(sendInput("message-2"))).ok).toBe(true);
		expect((await value.mailbox.send(sendInput("message-3", value.roster[1]!))).ok).toBe(true);
		const sent = await value.ledger.find({ kind: "fact", objectType: SUBAGENT_MAILBOX_SENT_OBJECT_TYPE, order: "oldestFirst" });
		expect(sent.filter((record) => record.kind === "fact").map((record) => [record.objectId, record.correlation.laneId])).toEqual([
			["message-1", "child-lane-1"],
			["message-2", "child-lane-1"],
			["message-3", "child-lane-2"],
		]);

		const reloaded = fixtureFrom(value);
		const consumed = await reloaded.consume({
			schemaVersion: 1,
			sessionId: "session-mailbox",
			toAgentInstanceId: "child-1",
			byAttemptId: "attempt-child-1",
			limit: 2,
		});
		expect(consumed).toMatchObject({ ok: true });
		if (!consumed.ok) throw consumed.error;
		expect(consumed.value.map((message) => message.messageId)).toEqual(["message-1", "message-2"]);
		expect(consumed.value.every((message) => message.ack?.byAttemptId === "attempt-child-1")).toBe(true);
		const acknowledgements = await value.ledger.find({ kind: "fact", objectType: SUBAGENT_MAILBOX_ACK_OBJECT_TYPE });
		expect(acknowledgements.map((record) => record.correlation.laneId)).toEqual(["child-lane-1", "child-lane-1"]);
	});

	it("replays the original durable message without consulting an invalid clock", async () => {
		const value = fixture();
		const sent = await value.mailbox.send(sendInput("message-replay"));
		expect(sent).toMatchObject({ ok: true, value: { createdAt: new Date(START).toISOString() } });
		const reloaded = fixtureFrom(value, () => {
			throw new Error("clock must not run during replay");
		});
		expect(await reloaded.send(sendInput("message-replay"))).toMatchObject({
			ok: true,
			value: { createdAt: new Date(START).toISOString() },
		});
	});

	it("fails closed on extra keys, forged Session/lane, body, pending, and rate boundaries", async () => {
		const value = fixture({ maxBodyBytes: 1024, maxPendingPerRecipient: 1, maxMessagesPerWindow: 2 });
		expect(await value.mailbox.send({ ...sendInput("message-extra"), extra: true })).toMatchObject({
			ok: false,
			error: { code: "subagent_mailbox_invalid" },
		});
		expect(
			await value.mailbox.send({
				...sendInput("message-cross"),
				correlation: { ...sendInput("message-cross").correlation, sessionId: "foreign-session" },
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_mailbox_invalid" } });
			expect(
			await value.mailbox.send({
				...sendInput("message-large"),
				body: { text: "x".repeat(2048) },
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_mailbox_invalid" } });
		const totalBytes = fixture({ maxBodyBytes: 20 });
		expect(await totalBytes.mailbox.send({ ...sendInput("message-envelope"), body: {} })).toMatchObject({
			ok: false,
			error: { code: "subagent_mailbox_invalid" },
		});
		expect((await value.mailbox.send(sendInput("message-1"))).ok).toBe(true);
		expect(await value.mailbox.send(sendInput("message-2"))).toMatchObject({
			ok: false,
			error: { code: "subagent_mailbox_invalid" },
		});

		const rate = fixture({ maxPendingPerRecipient: 4, maxMessagesPerWindow: 1 });
		expect((await rate.mailbox.send(sendInput("rate-1"))).ok).toBe(true);
		expect(await rate.mailbox.send(sendInput("rate-2", rate.roster[1]!))).toMatchObject({
			ok: false,
			error: { code: "subagent_mailbox_invalid" },
		});
	});

	it("binds sender authority to the caller Attempt and rate limits by durable record time", async () => {
		const value = fixture({ maxMessagesPerWindow: 1, maxPendingPerRecipient: 4 });
		expect(
			await value.mailbox.send(
				sendInput("forged-sender", value.roster[1]!, {
					fromAgentInstanceId: "child-1",
					fromAttemptId: "attempt-child-2",
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_mailbox_invalid" } });

		value.setNow(Date.now());
		await value.ledgerForLane("child-lane-1").appendFact(
			SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
			"durable-rate-1",
			{
				schemaVersion: 1,
				messageId: "durable-rate-1",
				fromAgentInstanceId: "parent-1",
				toAgentInstanceId: "child-1",
				kind: "notice",
				body: {},
				correlation: {
					sessionId: "session-mailbox",
					laneId: "child-lane-1",
					taskId: "task-child-1",
					attemptId: "attempt-child-1",
					agentInstanceId: "child-1",
				},
				createdAt: new Date(START).toISOString(),
			},
			{
				clientRequestId: "durable-rate-1",
				expectedRevision: 0,
				correlation: {
					taskId: "task-child-1",
					attemptId: "attempt-child-1",
					agentInstanceId: "child-1",
				},
			},
		);
		expect(await value.mailbox.send(sendInput("durable-rate-2", value.roster[1]!))).toMatchObject({
			ok: false,
			error: { code: "subagent_mailbox_invalid" },
		});
	});

	it("serializes concurrent sends across pending and sender-rate limits", async () => {
		const pending = fixture({ maxPendingPerRecipient: 1, maxMessagesPerWindow: 4 });
		const pendingResults = await Promise.all([
			pending.mailbox.send(sendInput("pending-concurrent-1")),
			pending.mailbox.send(sendInput("pending-concurrent-2")),
		]);
		expect(pendingResults.filter((result) => result.ok)).toHaveLength(1);
		expect(pendingResults.filter((result) => !result.ok)).toMatchObject([
			{ ok: false, error: { code: "subagent_mailbox_invalid" } },
		]);

		const rate = fixture({ maxPendingPerRecipient: 4, maxMessagesPerWindow: 1 });
		const rateResults = await Promise.all([
			rate.mailbox.send(sendInput("rate-concurrent-1")),
			rate.mailbox.send(sendInput("rate-concurrent-2", rate.roster[1]!)),
		]);
		expect(rateResults.filter((result) => result.ok)).toHaveLength(1);
		expect(rateResults.filter((result) => !result.ok)).toMatchObject([
			{ ok: false, error: { code: "subagent_mailbox_invalid" } },
		]);
	});

	it("validates endpoint and roster duplicates before use", () => {
		expect(() => fixture({ endpoints: [parentEndpoint, { ...parentEndpoint }] })).toThrowError();
		expect(() => fixture({ roster: [child("child-1", "lane-1"), child("child-1", "lane-2")] })).toThrowError();
		expect(() =>
			fixture({ roster: [{ ...child("child-1", "lane-1"), ancestorIds: [], depth: 1 }] }),
		).toThrowError();
	});

	it("allows only the addressed Attempt to ack and rejects orphan durable acknowledgements", async () => {
		const value = fixture();
		await value.mailbox.send(sendInput("message-1"));
		expect(
			await value.mailbox.acknowledge({
				schemaVersion: 1,
				messageId: "message-1",
				toAgentInstanceId: "child-1",
				byAttemptId: "attempt-foreign",
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_mailbox_invalid" } });

		await value.ledgerForLane("child-lane-1").appendFact(
			SUBAGENT_MAILBOX_ACK_OBJECT_TYPE,
			"orphan-message",
			{
				schemaVersion: 1,
				messageId: "orphan-message",
				fromAgentInstanceId: "parent-1",
				toAgentInstanceId: "child-1",
				at: new Date(START).toISOString(),
				byAttemptId: "attempt-child-1",
			},
			{
				clientRequestId: "corrupt-orphan-ack",
				expectedRevision: 0,
				correlation: {
					taskId: "task-child-1",
					attemptId: "attempt-child-1",
					agentInstanceId: "child-1",
				},
			},
		);
		expect(
			await value.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-1",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_persistence_failed" } });
	});

	it("rejects corrupt durable metadata on direct send replay and acknowledgement", async () => {
		const replay = fixture();
		const input = sendInput("corrupt-replay");
		await replay.ledgerForLane("foreign-lane").appendFact(
			SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
			input.messageId,
			{
				schemaVersion: 1,
				messageId: input.messageId,
				fromAgentInstanceId: input.fromAgentInstanceId,
				toAgentInstanceId: input.toAgentInstanceId,
				kind: input.kind,
				body: input.body,
				correlation: input.correlation,
				createdAt: new Date(START).toISOString(),
			},
			{
				clientRequestId: "corrupt-replay",
				expectedRevision: 0,
				correlation: {
					taskId: "task-child-1",
					attemptId: "attempt-child-1",
					agentInstanceId: "child-1",
				},
			},
		);
		expect(await replay.mailbox.send(input)).toMatchObject({
			ok: false,
			error: { code: "subagent_persistence_failed" },
		});

		const acknowledgement = fixture();
		expect((await acknowledgement.mailbox.send(sendInput("corrupt-ack"))).ok).toBe(true);
		await acknowledgement.ledgerForLane("foreign-lane").appendFact(
			SUBAGENT_MAILBOX_ACK_OBJECT_TYPE,
			"corrupt-ack",
			{
				schemaVersion: 1,
				messageId: "corrupt-ack",
				fromAgentInstanceId: "parent-1",
				toAgentInstanceId: "child-1",
				at: new Date(START).toISOString(),
				byAttemptId: "attempt-child-1",
			},
			{
				clientRequestId: "corrupt-ack",
				expectedRevision: 0,
				correlation: {
					taskId: "task-child-1",
					attemptId: "attempt-child-1",
					agentInstanceId: "child-1",
				},
			},
		);
		expect(
			await acknowledgement.mailbox.acknowledge({
				schemaVersion: 1,
				messageId: "corrupt-ack",
				toAgentInstanceId: "child-1",
				byAttemptId: "attempt-child-1",
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_persistence_failed" } });
	});

	it("ignores truly malformed foreign facts but rejects malformed facts touching local ownership", async () => {
		const foreign = fixture();
		await foreign.ledgerForLane("foreign-lane").appendFact(
			SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
			"foreign-malformed-sent",
			{ broken: true },
			{
				clientRequestId: "foreign-malformed-sent",
				expectedRevision: 0,
				correlation: {
					taskId: "task-foreign",
					attemptId: "attempt-foreign",
					agentInstanceId: "foreign-agent",
				},
			},
		);
		await foreign.ledgerForLane("foreign-lane").appendFact(
			SUBAGENT_MAILBOX_ACK_OBJECT_TYPE,
			"foreign-malformed-ack",
			{ malformed: "ack" },
			{
				clientRequestId: "foreign-malformed-ack",
				expectedRevision: 0,
				correlation: {
					taskId: "task-foreign",
					attemptId: "attempt-foreign",
					agentInstanceId: "foreign-agent",
				},
			},
		);
		expect(
			await foreign.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-1",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true, value: { pendingMessages: 0 } });

		const partial = fixture();
		await partial.ledgerForLane("foreign-lane").appendFact(
			SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
			"partial-malformed-sent",
			{ fromAgentInstanceId: "parent-1", broken: true },
			{
				clientRequestId: "partial-malformed-sent",
				expectedRevision: 0,
				correlation: {
					taskId: "task-foreign",
					attemptId: "attempt-foreign",
					agentInstanceId: "foreign-agent",
				},
			},
		);
		expect(
			await partial.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-1",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_persistence_failed" } });
	});

	it("isolates two mailbox ownership sets sharing one Session", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-mailbox", createdAt: 1 }));
		const parentA: ChildMailboxEndpointV1 = {
			...parentEndpoint,
			laneId: "parent-lane-a",
			agentInstanceId: "parent-a",
			attemptId: "attempt-parent-a",
		};
		const parentB: ChildMailboxEndpointV1 = {
			...parentEndpoint,
			laneId: "parent-lane-b",
			agentInstanceId: "parent-b",
			attemptId: "attempt-parent-b",
		};
		const rosterA = [child("child-a", "child-lane-a")];
		const rosterB = [child("child-b", "child-lane-b")];
		const first = fixture({ session, laneId: parentA.laneId, endpoints: [parentA], roster: rosterA });
		const second = fixture({ session, laneId: parentB.laneId, endpoints: [parentB], roster: rosterB });
		expect(
			(
				await first.mailbox.send(
					sendInput("message-a", rosterA[0]!, {
						fromAgentInstanceId: parentA.agentInstanceId,
						fromAttemptId: parentA.attemptId,
					}),
				)
			).ok,
		).toBe(true);
		expect(
			(
				await second.mailbox.send(
					sendInput("message-b", rosterB[0]!, {
						fromAgentInstanceId: parentB.agentInstanceId,
						fromAttemptId: parentB.attemptId,
					}),
				)
			).ok,
		).toBe(true);
		expect(
			await second.mailbox.acknowledge({
				schemaVersion: 1,
				messageId: "message-b",
				toAgentInstanceId: "child-b",
				byAttemptId: "attempt-child-b",
			}),
		).toMatchObject({ ok: true });
		expect(
			await first.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-a",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true, value: { pendingMessages: 1 } });
		expect(
			await second.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-b",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true, value: { pendingMessages: 0 } });
	});

	it("waits on durable result_ref messages as well as terminal lifecycle", async () => {
		const value = fixture();
		const childOne = value.roster[0]!;
		const resultMessage = sendInput("result-1", {
			schemaVersion: 1,
			sessionId: parentEndpoint.sessionId,
			laneId: parentEndpoint.laneId,
			childAgentInstanceId: parentEndpoint.agentInstanceId,
			parentAgentInstanceId: "host-root",
			ancestorIds: ["host-root"],
			depth: 1,
			taskId: parentEndpoint.taskId,
			attemptId: parentEndpoint.attemptId,
			providerId: "host",
			providerKind: "in_process",
			status: "running",
			mailboxAddress: parentEndpoint.agentInstanceId,
		}, {
			fromAgentInstanceId: childOne.childAgentInstanceId,
			fromAttemptId: childOne.attemptId,
			toAgentInstanceId: parentEndpoint.agentInstanceId,
			kind: "result_ref",
			body: { artifactId: "untrusted-result" },
			correlation: {
				sessionId: parentEndpoint.sessionId,
				laneId: parentEndpoint.laneId,
				taskId: parentEndpoint.taskId,
				attemptId: parentEndpoint.attemptId,
				agentInstanceId: parentEndpoint.agentInstanceId,
			},
		});
		expect((await value.mailbox.send(resultMessage)).ok).toBe(true);
		expect(
			await value.mailbox.waitAny({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceIds: ["child-1", "child-2"],
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true, value: [{ childAgentInstanceId: "child-1", status: "running" }] });
		value.roster[1] = child("child-2", "child-lane-2", "succeeded");
		expect(
			await value.mailbox.waitAll({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceIds: ["child-1", "child-2"],
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true });
	});

	it("uses injected bounded delay for timeout without cancelling children", async () => {
		const value = fixture();
		const before = value.roster.map((entry) => entry.status);
		expect(
			await value.mailbox.waitAll({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceIds: ["child-1", "child-2"],
				timeoutMs: 25,
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_wait_timeout" } });
		expect(value.delayCalls).toEqual([10, 10, 5]);
		expect(value.roster.map((entry) => entry.status)).toEqual(before);
	});

	it("returns bounded query state and a deeply frozen read-only sibling roster", async () => {
		const value = fixture();
		await value.mailbox.send(sendInput("message-1"));
		expect(
			await value.mailbox.query({
				schemaVersion: 1,
				sessionId: "session-mailbox",
				childAgentInstanceId: "child-1",
				timeoutMs: 0,
			}),
		).toMatchObject({ ok: true, value: { pendingMessages: 1 } });
		const siblings = value.mailbox.siblingRoster({
			schemaVersion: 1,
			sessionId: "session-mailbox",
			agentInstanceId: "child-1",
		});
		expect(siblings).toMatchObject({ ok: true, value: [{ childAgentInstanceId: "child-2" }] });
		if (!siblings.ok) throw siblings.error;
		expect(Object.isFrozen(siblings.value)).toBe(true);
		expect(Object.isFrozen(siblings.value[0])).toBe(true);
	});
});

function fixtureFrom(value: Fixture, now: () => string = () => new Date(START).toISOString()): SubagentMailboxV1 {
	return new SubagentMailboxV1({
		schemaVersion: 1,
		ledger: value.ledger,
		ledgerForLane: value.ledgerForLane,
		sessionId: "session-mailbox",
		laneId: "parent-lane",
		roster: () => value.roster,
		endpoints: [parentEndpoint],
		maxBodyBytes: 1024,
		maxPendingPerRecipient: 3,
		maxMessagesPerWindow: 4,
		rateWindowMs: 100,
		maxWaitMs: 50,
		pollIntervalMs: 10,
		now,
		clock: () => START,
		delay: async () => {},
	});
}
