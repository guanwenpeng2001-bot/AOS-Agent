/**
 * Lightweight self-hosted Worker pool over the existing Scheduler registry.
 *
 * Each pool member is one Scheduler executor. Queue selection and capacity
 * remain owned by durable Scheduler selection reservations; this registry
 * adds only membership, heartbeat, and liveness state. A lost member is
 * removed from future selection before its in-flight claims are reconciled.
 */

import { FoundationError, Result, type ResultValue } from "@aos-agent/agent-core";
import type {
	SchedulerExecutorRegistration,
	SchedulerExecutorRegistry,
	SchedulerExecutorSelectionInput,
	SchedulerSelectionSettlementUsage,
} from "../scheduler/executors.ts";
import type { WorkerPoolBinding } from "./lifecycle.ts";

export const WORKER_POOL_STATUSES = ["starting", "ready", "running", "lost", "release"] as const;
export type WorkerPoolStatus = (typeof WORKER_POOL_STATUSES)[number];

export interface WorkerPoolMemberRecord {
	readonly schemaVersion: 1;
	readonly poolId: string;
	readonly workerId: string;
	readonly machineId: string;
	readonly locality: "local" | "remote";
	readonly providerId: string;
	readonly status: WorkerPoolStatus;
	readonly maxConcurrency: number;
	readonly activeClaims: number;
	readonly heartbeatTimeoutMs: number;
	readonly registeredAt: string;
	readonly lastHeartbeatAt?: string;
	readonly revision: number;
}

export interface WorkerPoolMemberRegistration {
	readonly workerId: string;
	readonly machineId: string;
	readonly locality: "local" | "remote";
	readonly maxConcurrency: number;
	readonly heartbeatTimeoutMs: number;
	readonly registeredAt: string;
	readonly scheduler: SchedulerExecutorRegistration;
}

export interface WorkerPoolHeartbeat {
	readonly workerId: string;
	readonly sequence: number;
	readonly at: string;
}

export interface WorkerPoolAssignmentInput extends SchedulerExecutorSelectionInput {
	/** Existing Operation Worker reconcile/reclaim path for this in-flight claim. */
	readonly reconcile?: () => Promise<ResultValue<void, FoundationError>>;
}

export interface WorkerPoolAssignment {
	readonly schemaVersion: 1;
	readonly poolId: string;
	readonly workerId: string;
	readonly providerId: string;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly assignedAt: string;
}

export interface WorkerPoolRegistryOptions {
	readonly poolId: string;
	readonly scheduler: SchedulerExecutorRegistry;
}

interface MemberState {
	record: WorkerPoolMemberRecord;
	readonly registration: SchedulerExecutorRegistration;
	heartbeatSequence?: number;
	schedulerRegistered: boolean;
}

interface ClaimState {
	readonly assignment: WorkerPoolAssignment;
	readonly reconcile?: () => Promise<ResultValue<void, FoundationError>>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function poolError(
	code: "worker_invalid" | "worker_conflict" | "worker_not_found" | "worker_persistence_failed",
	message: string,
): FoundationError {
	return new FoundationError(code, message);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cloneRecord(record: WorkerPoolMemberRecord): WorkerPoolMemberRecord {
	return Object.freeze({ ...record });
}

function cloneAssignment(assignment: WorkerPoolAssignment): WorkerPoolAssignment {
	return Object.freeze({ ...assignment });
}

/**
 * Session-scoped pool view. The supplied Scheduler registry must own durable
 * selection reservations so concurrent claims remain atomic across hosts.
 */
export class WorkerPoolRegistry {
	readonly poolId: string;
	private readonly scheduler: SchedulerExecutorRegistry;
	private readonly members = new Map<string, MemberState>();
	private readonly workerIdByProviderId = new Map<string, string>();
	private readonly claims = new Map<string, ClaimState>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: WorkerPoolRegistryOptions) {
		if (!isIdentifier(options.poolId)) throw poolError("worker_invalid", "Worker pool identity is invalid");
		if (!options.scheduler.durableSelectionsEnabled()) {
			throw poolError("worker_invalid", "Worker pool requires durable Scheduler selection reservations");
		}
		this.poolId = options.poolId;
		this.scheduler = options.scheduler;
	}

	register(input: WorkerPoolMemberRegistration): ResultValue<WorkerPoolMemberRecord, FoundationError> {
		const providerId = input.scheduler.entry.descriptor.providerId;
		if (
			!isIdentifier(input.workerId) ||
			!isIdentifier(input.machineId) ||
			!isIdentifier(providerId) ||
			(input.locality !== "local" && input.locality !== "remote") ||
			!isPositiveInteger(input.maxConcurrency) ||
			!isPositiveInteger(input.heartbeatTimeoutMs) ||
			!isTimestamp(input.registeredAt) ||
			input.scheduler.entry.registeredAt !== input.registeredAt ||
			(input.scheduler.maxConcurrency !== undefined && input.scheduler.maxConcurrency !== input.maxConcurrency)
		) {
			return Result.err(poolError("worker_invalid", "Worker pool registration is invalid"));
		}
		if (this.members.has(input.workerId) || this.workerIdByProviderId.has(providerId)) {
			return Result.err(poolError("worker_conflict", "Worker pool identity is already registered"));
		}
		const registration: SchedulerExecutorRegistration = Object.freeze({
			...input.scheduler,
			maxConcurrency: input.maxConcurrency,
		});
		const record = cloneRecord({
			schemaVersion: 1,
			poolId: this.poolId,
			workerId: input.workerId,
			machineId: input.machineId,
			locality: input.locality,
			providerId,
			status: "starting",
			maxConcurrency: input.maxConcurrency,
			activeClaims: 0,
			heartbeatTimeoutMs: input.heartbeatTimeoutMs,
			registeredAt: input.registeredAt,
			revision: 0,
		});
		this.members.set(input.workerId, { record, registration, schedulerRegistered: false });
		this.workerIdByProviderId.set(providerId, input.workerId);
		return Result.ok(record);
	}

	get(workerId: string): WorkerPoolMemberRecord | undefined {
		const found = this.members.get(workerId)?.record;
		return found === undefined ? undefined : cloneRecord(found);
	}

	list(): readonly WorkerPoolMemberRecord[] {
		return [...this.members.values()]
			.map(({ record }) => cloneRecord(record))
			.sort((left, right) => left.registeredAt.localeCompare(right.registeredAt) || left.workerId.localeCompare(right.workerId));
	}

	binding(workerId: string): WorkerPoolBinding | undefined {
		const record = this.members.get(workerId)?.record;
		if (record === undefined) return undefined;
		return Object.freeze({
			schemaVersion: 1,
			poolId: record.poolId,
			workerId: record.workerId,
			machineId: record.machineId,
			locality: record.locality,
			maxConcurrency: record.maxConcurrency,
		});
	}

	heartbeat(input: WorkerPoolHeartbeat): Promise<ResultValue<WorkerPoolMemberRecord, FoundationError>> {
		return this.serialize(async () => {
			const member = this.members.get(input.workerId);
			if (member === undefined) return Result.err(poolError("worker_not_found", "Worker pool member was not found"));
			if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !isTimestamp(input.at)) {
				return Result.err(poolError("worker_invalid", "Worker pool heartbeat is invalid"));
			}
			if (member.record.status === "lost" || member.record.status === "release") {
				return Result.err(poolError("worker_conflict", "Worker pool heartbeat is not allowed in this state"));
			}
			if (member.heartbeatSequence === input.sequence) {
				if (member.record.lastHeartbeatAt !== input.at) {
					return Result.err(poolError("worker_conflict", "Worker pool heartbeat sequence was reused"));
				}
				return Result.ok(cloneRecord(member.record));
			}
			if (
				(member.heartbeatSequence === undefined && input.sequence !== 1) ||
				(member.heartbeatSequence !== undefined && input.sequence !== member.heartbeatSequence + 1) ||
				input.at < (member.record.lastHeartbeatAt ?? member.record.registeredAt)
			) {
				return Result.err(poolError("worker_conflict", "Worker pool heartbeat is stale or has a gap"));
			}
			if (!member.schedulerRegistered) {
				const registered = await this.scheduler.register(member.registration);
				if (!registered.ok) return registered;
				member.schedulerRegistered = true;
			}
			member.heartbeatSequence = input.sequence;
			member.record = cloneRecord({
				...member.record,
				status: member.record.activeClaims === 0 ? "ready" : "running",
				lastHeartbeatAt: input.at,
				revision: member.record.revision + 1,
			});
			return Result.ok(member.record);
		});
	}

	assign(input: WorkerPoolAssignmentInput): Promise<ResultValue<WorkerPoolAssignment, FoundationError>> {
		return this.serialize(async () => {
			const selected = await this.scheduler.select(input);
			if (!selected.ok) return selected;
			const providerId = selected.value.entry.descriptor.providerId;
			const workerId = this.workerIdByProviderId.get(providerId);
			const member = workerId === undefined ? undefined : this.members.get(workerId);
			if (member === undefined || (member.record.status !== "ready" && member.record.status !== "running")) {
				await this.scheduler.settleSelection(input.queueEntry.queueEntryId, "restart_reconciled");
				return Result.err(poolError("worker_persistence_failed", "Scheduler selected a Worker outside the ready pool"));
			}
			const existing = this.claims.get(input.queueEntry.queueEntryId);
			if (existing !== undefined) return Result.ok(cloneAssignment(existing.assignment));
			const assignment = cloneAssignment({
				schemaVersion: 1,
				poolId: this.poolId,
				workerId: member.record.workerId,
				providerId,
				queueEntryId: input.queueEntry.queueEntryId,
				taskId: input.queueEntry.taskId,
				assignedAt: input.decidedAt,
			});
			this.claims.set(assignment.queueEntryId, {
				assignment,
				...(input.reconcile === undefined ? {} : { reconcile: input.reconcile }),
			});
			this.refreshMemberLoad(member);
			return Result.ok(assignment);
		});
	}

	settle(
		queueEntryId: string,
		usage: SchedulerSelectionSettlementUsage = {},
	): Promise<ResultValue<WorkerPoolMemberRecord, FoundationError>> {
		return this.serialize(async () => {
			const claim = this.claims.get(queueEntryId);
			if (claim === undefined) return Result.err(poolError("worker_not_found", "Worker pool claim was not found"));
			const settled = await this.scheduler.settleSelection(queueEntryId, "succeeded", usage);
			if (!settled.ok) return settled;
			this.claims.delete(queueEntryId);
			const member = this.members.get(claim.assignment.workerId);
			if (member === undefined) return Result.err(poolError("worker_persistence_failed", "Worker pool member disappeared"));
			this.refreshMemberLoad(member);
			return Result.ok(member.record);
		});
	}

	markLost(workerId: string, at: string): Promise<ResultValue<WorkerPoolMemberRecord, FoundationError>> {
		return this.serialize(() => this.markLostUnserialized(workerId, at));
	}

	reconcileExpired(at: string): Promise<ResultValue<readonly WorkerPoolMemberRecord[], FoundationError>> {
		return this.serialize(async () => {
			if (!isTimestamp(at)) return Result.err(poolError("worker_invalid", "Worker pool reconcile timestamp is invalid"));
			const now = Date.parse(at);
			const lost: WorkerPoolMemberRecord[] = [];
			for (const member of this.members.values()) {
				if (member.record.status === "lost" || member.record.status === "release") continue;
				const last = Date.parse(member.record.lastHeartbeatAt ?? member.record.registeredAt);
				if (now - last <= member.record.heartbeatTimeoutMs) continue;
				const reconciled = await this.markLostUnserialized(member.record.workerId, at);
				if (!reconciled.ok) return reconciled;
				lost.push(reconciled.value);
			}
			return Result.ok(Object.freeze(lost));
		});
	}

	release(workerId: string): Promise<ResultValue<WorkerPoolMemberRecord, FoundationError>> {
		return this.serialize(async () => {
			const member = this.members.get(workerId);
			if (member === undefined) return Result.err(poolError("worker_not_found", "Worker pool member was not found"));
			if (member.record.status === "release") return Result.ok(cloneRecord(member.record));
			if (member.record.activeClaims !== 0) {
				return Result.err(poolError("worker_conflict", "Running Worker pool member cannot be released"));
			}
			if (member.schedulerRegistered) {
				const removed = this.scheduler.unregister(member.record.providerId);
				if (!removed.ok) return removed;
				member.schedulerRegistered = false;
			}
			member.record = cloneRecord({
				...member.record,
				status: "release",
				revision: member.record.revision + 1,
			});
			return Result.ok(member.record);
		});
	}

	private async markLostUnserialized(
		workerId: string,
		at: string,
	): Promise<ResultValue<WorkerPoolMemberRecord, FoundationError>> {
		const member = this.members.get(workerId);
		if (member === undefined) return Result.err(poolError("worker_not_found", "Worker pool member was not found"));
		if (!isTimestamp(at) || at < (member.record.lastHeartbeatAt ?? member.record.registeredAt)) {
			return Result.err(poolError("worker_invalid", "Worker pool lost timestamp is invalid"));
		}
		if (member.record.status === "release") {
			return Result.err(poolError("worker_conflict", "Released Worker pool member cannot become lost"));
		}
		if (member.record.status !== "lost") {
			if (member.schedulerRegistered) {
				const removed = this.scheduler.unregister(member.record.providerId);
				if (!removed.ok) return removed;
				member.schedulerRegistered = false;
			}
			member.record = cloneRecord({ ...member.record, status: "lost", revision: member.record.revision + 1 });
		}
		let failure: FoundationError | undefined;
		for (const [queueEntryId, claim] of this.claims) {
			if (claim.assignment.workerId !== workerId) continue;
			if (claim.reconcile !== undefined) {
				try {
					const reconciled = await claim.reconcile();
					if (!reconciled.ok) failure ??= reconciled.error;
				} catch (error) {
					failure ??= new FoundationError("worker_reclaim_failed", "Worker pool claim reconcile failed", { cause: error });
				}
			}
			const settled = await this.scheduler.settleSelection(queueEntryId, "restart_reconciled");
			if (!settled.ok) {
				failure ??= settled.error;
				continue;
			}
			this.claims.delete(queueEntryId);
		}
		this.refreshMemberLoad(member);
		return failure === undefined ? Result.ok(member.record) : Result.err(failure);
	}

	private refreshMemberLoad(member: MemberState): void {
		const activeClaims = [...this.claims.values()].filter(
			({ assignment }) => assignment.workerId === member.record.workerId,
		).length;
		member.record = cloneRecord({
			...member.record,
			activeClaims,
			status:
				member.record.status === "lost" || member.record.status === "release"
					? member.record.status
					: activeClaims === 0
						? "ready"
						: "running",
			revision: member.record.revision + 1,
		});
	}

	private async serialize<T>(
		operation: () => Promise<ResultValue<T, FoundationError>>,
	): Promise<ResultValue<T, FoundationError>> {
		const current = this.mutationTail.then(operation, operation);
		this.mutationTail = current.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await current;
		} catch (error) {
			void error;
			return Result.err(poolError("worker_persistence_failed", "Worker pool mutation failed"));
		}
	}
}
