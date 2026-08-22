import {
	type AppendFoundationRecordResultV1,
	type DurableLedgerApi,
	DurableLedgerError,
	type FoundationObjectResultV1,
	type FoundationRecordQueryV1,
	type FoundationRecordV1,
	type FoundationRetentionPolicyV1,
	InMemorySessionStorage,
	type LedgerWriterLeaseV1,
	type ProvisionedFoundationRecordV1,
	Result,
	Session,
	type SetRetentionPolicyOptionsV1,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE,
	SCHEDULER_HANDOFF_OBJECT_TYPE,
	SchedulerHandoffController,
} from "../src/core/scheduler-handoff.ts";
import {
	SCHEDULER_CLAIM_OBJECT_TYPE,
	SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
	SchedulerQueueStore,
} from "../src/core/scheduler-queue.ts";
import type { SchedulerOwnershipTransferV1, SchedulerQueueEntryV1 } from "../src/core/scheduler.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const DEADLINE = "2026-08-21T12:05:00.000Z";

function queued(overrides: Partial<SchedulerQueueEntryV1> = {}): SchedulerQueueEntryV1 {
	return {
		schemaVersion: 1,
		queueEntryId: "queue_1",
		sessionId: "session_a",
		taskId: "task_1",
		nodeRef: { taskId: "task_1", graphRevision: 1, nodeId: "node_1" },
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
		...overrides,
	};
}

function transfer(overrides: Partial<SchedulerOwnershipTransferV1> = {}): SchedulerOwnershipTransferV1 {
	return {
		schemaVersion: 1,
		transferId: "transfer_1",
		taskId: "task_1",
		fromOwnerId: "owner_source",
		toOwnerId: "owner_target",
		state: "offered",
		fencingToken: "fence_source",
		deadlineAt: DEADLINE,
		createdAt: NOW,
		revision: 0,
		...overrides,
	};
}

function expectCode(result: { ok: false; error: { code: string } } | { ok: true }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe(code);
}

class HandoffLedger implements DurableLedgerApi {
	readonly inner: DurableLedgerApi;
	readonly appends: ProvisionedFoundationRecordV1[] = [];
	readonly operations: string[] = [];
	failOnceOnObjectType: string | undefined;

	constructor(inner: DurableLedgerApi) {
		this.inner = inner;
	}

	acquireWriterLease(options: { ownerId: string; ttlMs?: number }): Promise<LedgerWriterLeaseV1> {
		return this.inner.acquireWriterLease(options);
	}
	renewWriterLease(options: { fencingToken: string; ttlMs?: number }): Promise<LedgerWriterLeaseV1> {
		return this.inner.renewWriterLease(options);
	}
	releaseWriterLease(options: { fencingToken: string }): Promise<void> {
		return this.inner.releaseWriterLease(options);
	}
	getWriterLease(): Promise<LedgerWriterLeaseV1 | null> {
		return this.inner.getWriterLease();
	}
	getLedgerRevision(): Promise<number> {
		return this.inner.getLedgerRevision();
	}
	async appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1> {
		this.appends.push(record);
		if (record.kind === "fact" && record.objectType === "scheduler.claim_released") {
			this.operations.push("source_release");
		}
		if (record.kind === "fact" && record.objectType === SCHEDULER_CLAIM_OBJECT_TYPE && record.objectId === "claim_target") {
			this.operations.push("target_claim");
		}
		if (record.kind === "fact" && record.objectType === this.failOnceOnObjectType) {
			this.failOnceOnObjectType = undefined;
			throw new DurableLedgerError("session_writer_busy", "Forced handoff crash");
		}
		return this.inner.appendFoundationRecord(record);
	}
	setRetentionPolicy(
		policy: FoundationRetentionPolicyV1,
		options: SetRetentionPolicyOptionsV1,
	): Promise<AppendFoundationRecordResultV1> {
		return this.inner.setRetentionPolicy(policy, options);
	}
	findFoundationRecords(query?: FoundationRecordQueryV1): Promise<FoundationRecordV1[]> {
		return this.inner.findFoundationRecords(query);
	}
	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResultV1 | undefined> {
		return this.inner.getFoundationObject(objectType, objectId);
	}
	getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return this.inner.getFoundationRevision(objectType, objectId);
	}
	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return this.inner.isObjectTombstoned(objectType, objectId);
	}
	getRetentionPolicy(): Promise<FoundationRetentionPolicyV1 | undefined> {
		return this.inner.getRetentionPolicy();
	}
	prunableFoundationRecords(): Promise<readonly FoundationRecordV1[]> {
		return this.inner.prunableFoundationRecords();
	}
}

function createHarness(options: { now?: () => string } = {}): {
	readonly session: Session;
	readonly ledger: HandoffLedger;
	readonly queue: SchedulerQueueStore;
} {
	const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
	const ledger = new HandoffLedger(session);
	const queue = new SchedulerQueueStore({
		ledger,
		sessionId: "session_a",
		ownerId: "scheduler_owner",
		now: options.now ?? (() => NOW),
	});
	return { session, ledger, queue };
}

async function claimSource(queue: SchedulerQueueStore, entry: SchedulerQueueEntryV1 = queued()): Promise<void> {
	expect((await queue.enqueue(entry)).ok).toBe(true);
	expect(
		(
			await queue.claim({
				queueEntryId: entry.queueEntryId,
				ownerId: "owner_source",
				claimId: `claim_source_${entry.queueEntryId}`,
				fencingToken: `fence_source_${entry.queueEntryId}`,
			})
		).ok,
	).toBe(true);
}

describe("scheduler T6b durable handoff", () => {
	it("cancels in-flight source work before atomically transferring ownership", async () => {
		const { ledger, queue } = createHarness();
		expect((await queue.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await queue.claim({
					queueEntryId: "queue_1",
					ownerId: "owner_source",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await queue.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: "fence_source",
					dispatchId: "dispatch_source",
					attemptId: "attempt_source",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);
		const controller = new SchedulerHandoffController({
			ledger,
			queue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
			cancelSourceDispatch: async () => {
				ledger.operations.push("cancel_source");
				return Result.ok(undefined);
			},
			targetAvailable: async () => true,
		});
		expect((await controller.offer({ queueEntryId: "queue_1", transfer: transfer() })).ok).toBe(true);
		const accepted = await controller.accept({
			transferId: "transfer_1",
			targetClaimId: "claim_target",
			targetFencingToken: "fence_target",
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.value.transfer.state).toBe("accepted");
		expect(accepted.value.claimTransfer?.entry).toMatchObject({ state: "claimed", claimId: "claim_target" });
		expect(ledger.operations).toEqual(["cancel_source", "source_release", "target_claim"]);
		expectCode(
			await queue.markTerminal({
				queueEntryId: "queue_1",
				dispatchId: "dispatch_source",
				attemptId: "attempt_source",
				fencingToken: "fence_source",
				outcome: "cancelled",
			}),
			"scheduler_lease_lost",
		);
		const queueSnapshot = await queue.snapshot();
		expect(queueSnapshot.ok).toBe(true);
		if (!queueSnapshot.ok) return;
		expect(queueSnapshot.value.dispatches[0]?.status).toBe("cancelled");
		expect(queueSnapshot.value.claims).toHaveLength(2);
		const replayed = await controller.accept({
			transferId: "transfer_1",
			targetClaimId: "claim_target",
			targetFencingToken: "fence_target",
		});
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.claimTransfer?.targetClaim.fencingToken).toBe("fence_target");
		expectCode(
			await controller.accept({
				transferId: "transfer_1",
				targetClaimId: "claim_conflict",
				targetFencingToken: "fence_target",
			}),
			"scheduler_handoff_invalid",
		);
	});

	it("reloads and resumes a crash after source cancellation without cancelling twice", async () => {
		const { ledger, queue } = createHarness();
		expect((await queue.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await queue.claim({
					queueEntryId: "queue_1",
					ownerId: "owner_source",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await queue.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: "fence_source",
					dispatchId: "dispatch_source",
					attemptId: "attempt_source",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);
		let cancellations = 0;
		const controller = new SchedulerHandoffController({
			ledger,
			queue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
			cancelSourceDispatch: async () => {
				cancellations += 1;
				return Result.ok(undefined);
			},
		});
		expect((await controller.offer({ queueEntryId: "queue_1", transfer: transfer() })).ok).toBe(true);
		ledger.failOnceOnObjectType = SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE;
		expectCode(
			await controller.accept({
				transferId: "transfer_1",
				targetClaimId: "claim_target",
				targetFencingToken: "fence_target",
			}),
			"scheduler_persistence_failed",
		);
		expect(cancellations).toBe(1);

		const reloadedQueue = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
		});
		const recovered = new SchedulerHandoffController({
			ledger,
			queue: reloadedQueue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
			cancelSourceDispatch: async () => {
				cancellations += 1;
				return Result.ok(undefined);
			},
		});
		const outcomes = await recovered.recover();
		expect(outcomes.ok).toBe(true);
		if (!outcomes.ok) return;
		expect(outcomes.value).toHaveLength(1);
		expect(outcomes.value[0]?.transfer.state).toBe("accepted");
		expect(cancellations).toBe(1);
		const snapshot = await recovered.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.transfers[0]?.state).toBe("accepted");
		expect(snapshot.value.acceptances[0]?.state).toBe("claim_transferred");
	});

	it("times out or cancels an unaccepted offer without cancelling source work", async () => {
		let now = NOW;
		const { ledger, queue } = createHarness({ now: () => now });
		await claimSource(queue, queued({
			queueEntryId: "queue_timeout",
			taskId: "task_timeout",
			nodeRef: { taskId: "task_timeout", graphRevision: 1, nodeId: "node_timeout" },
		}));
		await claimSource(queue, queued({
			queueEntryId: "queue_cancel",
			taskId: "task_cancel",
			nodeRef: { taskId: "task_cancel", graphRevision: 1, nodeId: "node_cancel" },
		}));
		let cancellations = 0;
		const controller = new SchedulerHandoffController({
			ledger,
			queue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => now,
			cancelSourceDispatch: async () => {
				cancellations += 1;
				return Result.ok(undefined);
			},
		});
		expect(
			(
				await controller.offer({
					queueEntryId: "queue_timeout",
					transfer: transfer({
						transferId: "transfer_timeout",
						taskId: "task_timeout",
						fencingToken: "fence_source_queue_timeout",
					}),
				})
			).ok,
		).toBe(true);
		expect(
			(
				await controller.offer({
					queueEntryId: "queue_cancel",
					transfer: transfer({
						transferId: "transfer_cancel",
						taskId: "task_cancel",
						fencingToken: "fence_source_queue_cancel",
					}),
				})
			).ok,
		).toBe(true);
		const cancelled = await controller.decide("transfer_cancel", "cancelled");
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;
		expect(cancelled.value.transfer.state).toBe("cancelled");

		now = "2026-08-21T12:06:00.000Z";
		const timedOut = await controller.recover();
		expect(timedOut.ok).toBe(true);
		if (!timedOut.ok) return;
		expect(timedOut.value).toHaveLength(1);
		expect(timedOut.value[0]?.transfer.state).toBe("timed_out");
		expect(cancellations).toBe(0);
		const timeoutEntry = await queue.getEntry("queue_timeout");
		expect(timeoutEntry.ok).toBe(true);
		if (!timeoutEntry.ok) return;
		expect(timeoutEntry.value).toMatchObject({ state: "claimed", claimId: "claim_source_queue_timeout" });
	});

	it("rejects an offer without changing its source and accepts a later offer for the same entry", async () => {
		const { ledger, queue } = createHarness();
		expect((await queue.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await queue.claim({
					queueEntryId: "queue_1",
					ownerId: "owner_source",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		const sourceEntry = await queue.getEntry("queue_1");
		const sourceClaim = await queue.getClaim("claim_source");
		expect(sourceEntry.ok).toBe(true);
		expect(sourceClaim.ok).toBe(true);
		if (!sourceEntry.ok || !sourceClaim.ok) return;

		const controller = new SchedulerHandoffController({
			ledger,
			queue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
		});
		expect(
			(
				await controller.offer({
					queueEntryId: "queue_1",
					transfer: transfer({ transferId: "transfer_rejected" }),
				})
			).ok,
		).toBe(true);
		const rejected = await controller.decide("transfer_rejected", "rejected");
		expect(rejected.ok).toBe(true);
		if (!rejected.ok) return;
		expect(rejected.value.transfer.state).toBe("rejected");
		expect(await queue.getEntry("queue_1")).toEqual(sourceEntry);
		expect(await queue.getClaim("claim_source")).toEqual(sourceClaim);

		expect(
			(
				await controller.offer({
					queueEntryId: "queue_1",
					transfer: transfer({ transferId: "transfer_after_rejection", toOwnerId: "owner_next" }),
				})
			).ok,
		).toBe(true);
		const accepted = await controller.accept({
			transferId: "transfer_after_rejection",
			targetClaimId: "claim_next",
			targetFencingToken: "fence_next",
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.value.transfer.state).toBe("accepted");
		expect(accepted.value.claimTransfer?.entry).toMatchObject({ state: "claimed", claimId: "claim_next" });
		expectCode(
			await controller.decide("transfer_after_rejection", "rejected"),
			"scheduler_handoff_invalid",
		);
	});

	it("leaves the source owner active when the target is unavailable", async () => {
		const { ledger, queue } = createHarness();
		expect((await queue.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await queue.claim({
					queueEntryId: "queue_1",
					ownerId: "owner_source",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		const controller = new SchedulerHandoffController({
			ledger,
			queue,
			sessionId: "session_a",
			ownerId: "scheduler_owner",
			now: () => NOW,
			targetAvailable: async () => false,
		});
		expect((await controller.offer({ queueEntryId: "queue_1", transfer: transfer() })).ok).toBe(true);
		expectCode(
			await controller.accept({
				transferId: "transfer_1",
				targetClaimId: "claim_target",
				targetFencingToken: "fence_target",
			}),
			"scheduler_handoff_target_unavailable",
		);
		const entry = await queue.getEntry("queue_1");
		expect(entry.ok).toBe(true);
		if (!entry.ok) return;
		expect(entry.value).toMatchObject({ state: "claimed", claimId: "claim_source" });
		const snapshot = await controller.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.transfers[0]?.state).toBe("offered");
		expect(snapshot.value.acceptances).toEqual([]);
		const objectTypes = ledger.appends.flatMap((append) => append.kind === "fact" ? [append.objectType] : []);
		expect(objectTypes).toContain(SCHEDULER_HANDOFF_OBJECT_TYPE);
		expect(objectTypes).not.toContain(SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE);
		expect(objectTypes.every((objectType) => objectType.startsWith("scheduler."))).toBe(true);
	});
});
