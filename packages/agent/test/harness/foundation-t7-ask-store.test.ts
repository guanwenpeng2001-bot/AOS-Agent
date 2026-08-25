import { describe, expect, it } from "vitest";
import { AskStore } from "../../src/harness/foundation/ask-store.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import type { ProvisionedFoundationRecord } from "../../src/harness/session/durable/types.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

const DUE_AT = "2026-08-19T12:00:00.000Z";
const ESCALATION_AT = "2026-08-19T11:30:00.000Z";

function createStore(id: string): { readonly session: Session; readonly store: AskStore } {
	const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
	return { session, store: new AskStore(session) };
}

function options(
	clientRequestId: string,
	expectedRevision: number,
): { readonly clientRequestId: string; readonly expectedRevision: number } {
	return { clientRequestId, expectedRevision };
}

async function createAsk(store: AskStore, requestId: string, suffix = "") {
	const sessionId = (await store.session.getMetadata()).id;
	return store.create(
		{
			sessionId,
			askId: `ask-${suffix || requestId}`,
			question: "Continue?",
			goalId: "goal-1",
			taskId: "task-1",
			options: ["yes", "no"],
			dueAt: DUE_AT,
			escalationAt: ESCALATION_AT,
			escalationTarget: "operator-1",
		},
		options(requestId, 0),
	);
}

function injectAppendFault(
	session: Session,
	predicate: (record: ProvisionedFoundationRecord) => boolean,
	phase: "before" | "after",
): () => void {
	const original = session.appendFoundationRecord.bind(session);
	let injected = false;
	session.appendFoundationRecord = async (record) => {
		if (!injected && phase === "before" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected AskStore crash");
		}
		const accepted = await original(record);
		if (!injected && phase === "after" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected AskStore crash");
		}
		return accepted;
	};
	return () => {
		session.appendFoundationRecord = original;
	};
}

describe("AskStore durability", () => {
	it("persists one idempotent Reply without granting permissions", async () => {
		const { session, store } = createStore("ask-reply");
		const ask = await createAsk(store, "create");
		const answered = await store.reply(
			ask.askId,
			{ replyId: "reply-1", by: "operator-1", value: { choice: "yes" } },
			options("reply", 1),
		);
		expect(answered).toMatchObject({
			status: "answered",
			revision: 2,
			reply: { replyId: "reply-1", value: { choice: "yes" } },
		});
		expect("permissions" in answered).toBe(false);
		expect("approval" in answered).toBe(false);
		expect(
			await store.reply(
				ask.askId,
				{ replyId: "reply-1", by: "operator-1", value: { choice: "yes" } },
				options("reply", 1),
			),
		).toEqual(answered);
		await expect(
			store.reply(ask.askId, { replyId: "reply-1", by: "operator-1", value: { choice: "no" } }, options("reply", 1)),
		).rejects.toMatchObject({ code: "session_writer_duplicate_request" });
		expect((await store.eventsFor(ask.askId)).map((event) => event.type)).toEqual(["ask.created", "ask.answered"]);
		expect(
			await session.findFoundationRecords({ objectType: "foundation.ask.reply", kind: "fact", includePruned: true }),
		).toHaveLength(1);
	});

	it("uses explicit timestamps for expiry and rejects early settlement", async () => {
		const { store } = createStore("ask-expiry");
		const ask = await createAsk(store, "create");
		await expect(
			store.expire(ask.askId, { at: "2026-08-19T11:59:59.999Z" }, options("expire-early", 1)),
		).rejects.toMatchObject({ code: "ask_timeout_not_reached" });
		expect((await store.get(ask.askId)).revision).toBe(1);
		const expired = await store.expire(ask.askId, { at: DUE_AT }, options("expire", 1));
		expect(expired).toMatchObject({ status: "expired", revision: 2, settledAt: DUE_AT, updatedAt: DUE_AT });
		await expect(
			store.reply(ask.askId, { by: "operator-1", value: "late" }, options("late-reply", 2)),
		).rejects.toMatchObject({ code: "ask_invalid_transition" });
	});

	it("escalates or cancels pending Asks as durable terminal facts", async () => {
		const { store } = createStore("ask-terminal");
		const escalatedAsk = await createAsk(store, "create-escalated", "escalated");
		await expect(
			store.escalate(escalatedAsk.askId, { at: "2026-08-19T11:29:59.999Z" }, options("escalate-early", 1)),
		).rejects.toMatchObject({ code: "ask_escalation_not_reached" });
		const escalated = await store.escalate(escalatedAsk.askId, { at: ESCALATION_AT }, options("escalate", 1));
		expect(escalated).toMatchObject({
			status: "escalated",
			escalationTarget: "operator-1",
			settledAt: ESCALATION_AT,
		});

		const cancelledAsk = await createAsk(store, "create-cancelled", "cancelled");
		const cancelled = await store.cancel(cancelledAsk.askId, "no longer needed", options("cancel", 1));
		expect(cancelled).toMatchObject({ status: "cancelled", revision: 2, tombstone: { reason: "no longer needed" } });
		await expect(
			store.expire(cancelledAsk.askId, { at: DUE_AT }, options("expire-cancelled", 2)),
		).rejects.toMatchObject({ code: "ask_invalid_transition" });
	});

	it("recovers crashes after command intent and after Ask CAS", async () => {
		const { session, store } = createStore("ask-recovery");
		const restoreIntent = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.ask",
			"before",
		);
		await expect(createAsk(store, "create-intent", "intent")).rejects.toMatchObject({
			code: "session_ledger_storage",
		});
		restoreIntent();
		const recoveredCreate = await createAsk(store, "create-intent", "intent");
		expect(recoveredCreate.revision).toBe(1);

		const restoreEvent = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.ask.event",
			"after",
		);
		await expect(
			store.reply(recoveredCreate.askId, { by: "operator-1", value: ["yes"] }, options("reply-recovery", 1)),
		).rejects.toMatchObject({ code: "session_ledger_storage" });
		restoreEvent();
		const recoveredReply = await store.reply(
			recoveredCreate.askId,
			{ by: "operator-1", value: ["yes"] },
			options("reply-recovery", 1),
		);
		expect(recoveredReply).toMatchObject({ status: "answered", revision: 2, reply: { value: ["yes"] } });
		expect(await store.eventsFor(recoveredCreate.askId)).toHaveLength(2);
	});

	it("enforces aggregate CAS across distinct Reply requests", async () => {
		const { store } = createStore("ask-cas");
		const ask = await createAsk(store, "create");
		const outcomes = await Promise.allSettled([
			store.reply(ask.askId, { by: "left", value: "left" }, options("reply-left", 1)),
			store.reply(ask.askId, { by: "right", value: "right" }, options("reply-right", 1)),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({ code: "session_writer_stale_revision" });
		expect((await store.get(ask.askId)).revision).toBe(2);
	});
});
