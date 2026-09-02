import {
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedgerWriter,
	type TaskExecutorProvider,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import {
	SchedulerExecutorDiscovery,
	SCHEDULER_EXECUTOR_DISCOVERY_OBJECT_TYPE,
} from "../../src/core/scheduler/executor-discovery.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	type SchedulerExecutorRegistration,
} from "../../src/core/scheduler/executors.ts";
import { SchedulerHandoffController } from "../../src/core/scheduler/handoff.ts";
import type {
	SchedulerExecutorEntry,
	SchedulerOwnershipTransfer,
	SchedulerQueueEntry,
} from "../../src/core/scheduler/host.ts";
import { SchedulerQueueStore } from "../../src/core/scheduler/queue.ts";

const NOW = "2026-08-23T00:00:00.000Z";
const SHARED_OWNER = "scheduler-shared-owner";
const CAPABILITY = {
	schemaVersion: 1 as const,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function executorEntry(providerId: string): SchedulerExecutorEntry {
	return {
		schemaVersion: 1,
		descriptor: { schemaVersion: 1, providerId, providerClass: "task_executor" },
		capabilities: [CAPABILITY],
		costClass: "remote_paid",
		registeredAt: NOW,
	};
}

function executor(providerId: string): SchedulerInProcessTaskExecutorProvider {
	return new SchedulerInProcessTaskExecutorProvider({
		providerId,
		now: () => NOW,
	});
}

function registration(provider: TaskExecutorProvider): SchedulerExecutorRegistration {
	return {
		entry: executorEntry(provider.providerId),
		provider,
		trusted: true,
		latencyMs: 10,
		load: 0,
		maxConcurrency: 2,
	};
}

function queued(id: string, taskId = `task_${id}`): SchedulerQueueEntry {
	return {
		schemaVersion: 1,
		queueEntryId: id,
		sessionId: "session-shared",
		taskId,
		state: "queued",
		priority: 0,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
	};
}

function transfer(
	queueEntry: SchedulerQueueEntry,
	fencingToken: string,
	toOwnerId: string,
	overrides: Partial<SchedulerOwnershipTransfer> = {},
): SchedulerOwnershipTransfer {
	return {
		schemaVersion: 1,
		transferId: `transfer_${queueEntry.queueEntryId}`,
		taskId: queueEntry.taskId,
		fromOwnerId: "host-a",
		toOwnerId,
		state: "offered",
		fencingToken,
		deadlineAt: "2026-08-23T00:00:10.000Z",
		createdAt: NOW,
		revision: 0,
		...overrides,
	};
}

function expectCode(result: { ok: false; error: { code: string } } | { ok: true }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe(code);
}

describe("cross-host executor discovery", () => {
	it("projects two Hosts from the shared ledger and excludes explicit or heartbeat-offline executors", async () => {
		let now = NOW;
		const session = new Session(new InMemorySessionStorage({ id: "session-shared", createdAt: 1 }));
		const writer = new SessionLedgerWriter(session, { ownerId: SHARED_OWNER });
		const providers = new Map<string, TaskExecutorProvider>([
			["executor-a", executor("executor-a")],
			["executor-b", executor("executor-b")],
		]);
		const registryA = new SchedulerExecutorRegistry();
		const registryB = new SchedulerExecutorRegistry();
		const resolveExecutor = (record: { readonly entry: SchedulerExecutorEntry }) => {
			const provider = providers.get(record.entry.descriptor.providerId);
			return provider === undefined ? undefined : { provider };
		};
		const hostA = new SchedulerExecutorDiscovery({
			session,
			registry: registryA,
			ownerId: SHARED_OWNER,
			writer,
			resolveExecutor,
			now: () => now,
		});
		const hostB = new SchedulerExecutorDiscovery({
			session,
			registry: registryB,
			ownerId: SHARED_OWNER,
			writer,
			resolveExecutor,
			now: () => now,
		});

		try {
			const registeredA = await hostA.register({
						hostId: "host-a",
						registration: registration(providers.get("executor-a")!),
						ttlMs: 2_000,
						clientRequestId: "register-executor-a",
					});
			if (!registeredA.ok) throw registeredA.error;
			const replayedA = await hostA.register({
				hostId: "host-a",
				registration: registration(providers.get("executor-a")!),
				ttlMs: 2_000,
				clientRequestId: "register-executor-a",
			});
			expect(replayedA).toEqual(registeredA);
			expect(
				(
					await hostB.register({
						hostId: "host-b",
						registration: registration(providers.get("executor-b")!),
						ttlMs: 4_000,
						clientRequestId: "register-executor-b",
					})
				).ok,
			).toBe(true);

			const discovered = await hostA.sync();
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;
			expect(discovered.value.live.map((record) => record.hostId)).toEqual(["host-a", "host-b"]);
			expect(registryA.list().map((entry) => entry.descriptor.providerId)).toEqual([
				"executor-a",
				"executor-b",
			]);
			expect(registryB.list().map((entry) => entry.descriptor.providerId)).toEqual([
				"executor-a",
				"executor-b",
			]);
			expect(await registryA.isOwnerAvailable("host-b")).toBe(true);

			const selected = await registryA.select({ queueEntry: queued("queue-before-offline"), decidedAt: now });
			expect(selected.ok).toBe(true);
			if (selected.ok) expect(selected.value.entry.descriptor.providerId).toBe("executor-a");

			expect(
				(
					await hostA.unregister({
						hostId: "host-a",
						providerId: "executor-a",
						clientRequestId: "unregister-executor-a",
					})
				).ok,
			).toBe(true);
			const selectedAfterUnregister = await registryB.select({
				queueEntry: queued("queue-after-unregister"),
				decidedAt: now,
			});
			expect(selectedAfterUnregister.ok).toBe(true);
			if (selectedAfterUnregister.ok) {
				expect(selectedAfterUnregister.value.entry.descriptor.providerId).toBe("executor-b");
			}

			now = "2026-08-23T00:00:05.000Z";
			const expired = await hostA.sync();
			expect(expired.ok).toBe(true);
			if (!expired.ok) return;
			expect(expired.value.live).toEqual([]);
			expect(registryA.list()).toEqual([]);
			expect(await registryA.isOwnerAvailable("host-b")).toBe(false);
			expectCode(
				await registryA.select({ queueEntry: queued("queue-after-expiry"), decidedAt: now }),
				"scheduler_no_executor",
			);
			const facts = await session.findFoundationRecords({
				objectType: SCHEDULER_EXECUTOR_DISCOVERY_OBJECT_TYPE,
				kind: "fact",
			});
			expect(facts).toHaveLength(3);
		} finally {
			await hostA.dispose();
			await hostB.dispose();
			await writer.releaseLease();
		}
	});

	it("gates handoff on discovered targets and reclaims lost in-flight work through queue recovery", async () => {
		let now = NOW;
		const session = new Session(new InMemorySessionStorage({ id: "session-shared", createdAt: 1 }));
		const writer = new SessionLedgerWriter(session, { ownerId: SHARED_OWNER });
		const registry = new SchedulerExecutorRegistry();
		const provider = executor("executor-b");
		const discovery = new SchedulerExecutorDiscovery({
			session,
			registry,
			ownerId: SHARED_OWNER,
			writer,
			resolveExecutor: (record) =>
				record.entry.descriptor.providerId === provider.providerId ? { provider } : undefined,
			now: () => now,
		});
		const cancelledAttempts: string[] = [];
		const queue = new SchedulerQueueStore({
			ledger: session,
			sessionId: "session-shared",
			ownerId: SHARED_OWNER,
			now: () => now,
			cancelAttempt: async (attemptId) => {
				cancelledAttempts.push(attemptId);
				return Result.ok(undefined);
			},
		});
		const handoff = new SchedulerHandoffController({
			ledger: session,
			queue,
			sessionId: "session-shared",
			ownerId: SHARED_OWNER,
			now: () => now,
			targetAvailable: (ownerId) => registry.isOwnerAvailable(ownerId),
		});

		try {
			const registered = await discovery.register({
						hostId: "host-b",
						registration: registration(provider),
						ttlMs: 2_000,
						clientRequestId: "register-host-b",
					});
			if (!registered.ok) throw registered.error;

			const acceptedEntry = queued("queue-accepted", "task-accepted");
			expect((await queue.enqueue(acceptedEntry)).ok).toBe(true);
			expect(
				(
					await queue.claim({
						queueEntryId: acceptedEntry.queueEntryId,
						ownerId: "host-a",
						claimId: "claim-source",
						fencingToken: "fence-source",
						ttlMs: 2_000,
					})
				).ok,
			).toBe(true);
			expect(
				(
					await handoff.offer({
						queueEntryId: acceptedEntry.queueEntryId,
						transfer: transfer(acceptedEntry, "fence-source", "host-b"),
					})
				).ok,
			).toBe(true);
			const accepted = await handoff.accept({
				transferId: "transfer_queue-accepted",
				targetClaimId: "claim-target",
				targetFencingToken: "fence-target",
				ttlMs: 10_000,
			});
			expect(accepted.ok).toBe(true);
			if (accepted.ok) expect(accepted.value.transfer.state).toBe("accepted");

			const lostEntry = queued("queue-lost", "task-lost");
			expect((await queue.enqueue(lostEntry)).ok).toBe(true);
			expect(
				(
					await queue.claim({
						queueEntryId: lostEntry.queueEntryId,
						ownerId: "host-b",
						claimId: "claim-lost",
						fencingToken: "fence-lost",
						ttlMs: 1_000,
					})
				).ok,
			).toBe(true);
			expect(
				(
					await queue.markDispatched({
						queueEntryId: lostEntry.queueEntryId,
						fencingToken: "fence-lost",
						dispatchId: "dispatch-lost",
						attemptId: "attempt-lost",
						providerId: provider.providerId,
						providerClass: "task_executor",
					})
				).ok,
			).toBe(true);

			now = "2026-08-23T00:00:03.000Z";
			const recovered = await discovery.reconcileLostExecutors(queue);
			expect(recovered.ok).toBe(true);
			if (!recovered.ok) return;
			expect(recovered.value).toEqual([
				expect.objectContaining({ action: "requeued", cancelledAttemptId: "attempt-lost" }),
			]);
			expect(cancelledAttempts).toEqual(["attempt-lost"]);
			const lostAfterRecovery = await queue.getEntry(lostEntry.queueEntryId);
			expect(lostAfterRecovery.ok).toBe(true);
			if (lostAfterRecovery.ok) expect(lostAfterRecovery.value.state).toBe("queued");

			const unavailableEntry = queued("queue-unavailable", "task-unavailable");
			expect((await queue.enqueue(unavailableEntry)).ok).toBe(true);
			expect(
				(
					await queue.claim({
						queueEntryId: unavailableEntry.queueEntryId,
						ownerId: "host-a",
						claimId: "claim-unavailable",
						fencingToken: "fence-unavailable",
						ttlMs: 2_000,
					})
				).ok,
			).toBe(true);
			expect(
				(
					await handoff.offer({
						queueEntryId: unavailableEntry.queueEntryId,
						transfer: transfer(unavailableEntry, "fence-unavailable", "host-b", {
							transferId: "transfer-unavailable",
							createdAt: now,
							deadlineAt: "2026-08-23T00:00:10.000Z",
						}),
					})
				).ok,
			).toBe(true);
			expectCode(await handoff.accept({ transferId: "transfer-unavailable" }), "scheduler_handoff_target_unavailable");
		} finally {
			await discovery.dispose();
			await writer.releaseLease();
		}
	});
});
