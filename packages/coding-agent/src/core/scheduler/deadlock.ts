/**
 * Production Scheduler deadlock, fairness, and backpressure controller.
 *
 * Collects wait-for edges from integrated Graph, Gate, Ask, handoff, and
 * queue claim state. Cycle detection is deterministic. A detected cycle
 * fails one sacrificial task by ascending queue-entry revision and appends
 * a durable SchedulerDeadlockFact plus scheduler.deadlock_detected.
 * Scans and ticks are iteration- and deadline-bounded.
 */
import {
	createDurableEvent,
	type DurableLedgerApi,
	DurableLedgerError,
	type EventCorrelationRef,
	fingerprintFoundationValue,
	type FoundationFactRecord,
	FoundationError,
	type FoundationJsonValue,
	type FoundationRecord,
	type LedgerWriterLease,
	Result,
	type ResultValue,
	type SchedulerClaimEventPayload,
	type SchedulerDeadlockEventPayload,
	type SchedulerDispatchEventPayload,
	type SchedulerQueueEventPayload,
} from "@aos-agent/agent-core";
import { runtimeClockFor, type RuntimeClock } from "../runtime-clock.ts";
import { SCHEDULER_MESSAGE_OBJECT_TYPES, type SchedulerAskWaitFact } from "./messages.ts";
import type { SchedulerHandoffController } from "./handoff.ts";
import { SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE, type SchedulerQueueSnapshot } from "./queue.ts";
import {
	applySchedulerDispatchTransition,
	applySchedulerEngineTransition,
	applySchedulerQueueTransition,
	isSchedulerQueueTerminal,
	parseSchedulerDeadlockFact,
	SCHEDULER_GLOBAL_MAX_ACTIVE_ATTEMPTS,
	SCHEDULER_HOST_DEFAULT_MAX_GRAPHS_PER_TICK,
	SCHEDULER_HOST_DEFAULT_MAX_NODES_PER_TICK,
	SCHEDULER_QUEUE_MAX_DEPTH,
	SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
	SCHEDULER_WAIT_EDGE_KINDS,
	type SchedulerDeadlockFact,
	type SchedulerDispatchRecord,
	type SchedulerEnqueueResult,
	type SchedulerErrorCode,
	type SchedulerQueueEntry,
	type SchedulerWaitEdgeKind,
	schedulerQueueBusinessKey,
	serializeSchedulerDeadlockFact,
	serializeSchedulerDispatchRecord,
	serializeSchedulerQueueEntry,
} from "./host.ts";
import type { TaskGateDecisionRequest, TaskGateStore } from "../policy/task-gate.ts";
import type { TaskGraphRecord, TaskGraphStore } from "./task-graph.ts";

export const SCHEDULER_DEADLOCK_OBJECT_TYPE = "scheduler.deadlock";
export const SCHEDULER_DEADLOCK_AGING_MS_PER_PRIORITY_UNIT = 1_000;
export const SCHEDULER_DEADLOCK_DEFAULT_TICK_TIMEOUT_MS = 1_000;
export const SCHEDULER_DEADLOCK_SCAN_HARD_CAP = 8_192;

const WRITER_LEASE_REFRESH_MS = 1_000;

const ERROR_MESSAGES: Readonly<Record<SchedulerErrorCode, string>> = {
	scheduler_queue_invalid: "Scheduler queue entry is invalid.",
	scheduler_queue_conflict: "Scheduler queue business key already has a different payload.",
	scheduler_claim_conflict: "Scheduler claim conflict: the task already has an active claim.",
	scheduler_claim_expired: "Scheduler claim lease is expired.",
	scheduler_lease_lost: "Scheduler fencing token is not the current claim token.",
	scheduler_no_executor: "No eligible scheduler executor is available.",
	scheduler_executor_unavailable: "The selected scheduler executor is unavailable.",
	scheduler_budget_exhausted_wait: "Scheduler concurrency or quota is exhausted; keep the entry queued.",
	scheduler_dispatch_invalid: "Scheduler dispatch record is invalid.",
	scheduler_attempt_recovery_failed: "Scheduler existing-attempt recovery failed.",
	scheduler_fanin_invalid: "Scheduler join input is invalid.",
	scheduler_settlement_rejected: "Scheduler settlement was rejected by the host gate.",
	scheduler_handoff_invalid: "Scheduler ownership transfer is invalid.",
	scheduler_handoff_timeout: "Scheduler ownership transfer timed out.",
	scheduler_handoff_target_unavailable: "Scheduler handoff target is unavailable.",
	scheduler_message_invalid: "Scheduler message is invalid or carries forbidden content.",
	scheduler_message_timeout: "Scheduler message acknowledgment timed out.",
	scheduler_wake_invalid: "Scheduler wake fact is invalid.",
	scheduler_deadlock_detected: "Scheduler wait-for cycle was detected.",
	scheduler_backpressure: "Scheduler queue or concurrency limit is exceeded.",
	scheduler_not_found: "Scheduler record was not found.",
	scheduler_persistence_failed: "Scheduler durable append failed; re-read current state.",
};

const RETRYABLE = new Set<SchedulerErrorCode>([
	"scheduler_claim_conflict",
	"scheduler_budget_exhausted_wait",
	"scheduler_backpressure",
]);

export type SchedulerBackpressureLimit = "queue_depth" | "session_active" | "global_active";

export interface SchedulerWaitForEdge {
	readonly fromTaskId: string;
	readonly toTaskId: string;
	readonly kind: SchedulerWaitEdgeKind;
}

export interface SchedulerBackpressureSignal {
	readonly code: "scheduler_backpressure";
	readonly limit: SchedulerBackpressureLimit;
	readonly sessionId?: string;
	readonly retained: number;
}

export interface SchedulerRetainedWork {
	readonly queueEntryId: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly reason: SchedulerBackpressureLimit;
	readonly candidate: SchedulerQueueEntry;
}

export interface SchedulerDeadlockTickError {
	readonly taskId: string;
	readonly code: string;
}

export interface SchedulerDeadlockTickResult {
	readonly enabled: boolean;
	readonly scannedGraphs: number;
	readonly scannedNodes: number;
	readonly scannedEdges: number;
	readonly cycles: number;
	readonly failedTaskIds: readonly string[];
	readonly facts: readonly SchedulerDeadlockFact[];
	readonly signals: readonly SchedulerBackpressureSignal[];
	readonly retained: readonly SchedulerRetainedWork[];
	readonly readyOrder: readonly string[];
	readonly timedOut: boolean;
	readonly errors: readonly SchedulerDeadlockTickError[];
}

export interface SchedulerDeadlockQueue {
	snapshot(): Promise<ResultValue<SchedulerQueueSnapshot, FoundationError>>;
	enqueue(
		candidate: unknown,
		options?: { readonly maxAttempts?: number },
	): Promise<ResultValue<SchedulerEnqueueResult, FoundationError>>;
}

export interface SchedulerDeadlockControllerOptions {
	/** Production control is inert unless explicitly enabled. */
	readonly enabled?: boolean;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly ledger: DurableLedgerApi;
	readonly graph: TaskGraphStore;
	readonly queue: SchedulerDeadlockQueue;
	readonly extraGraphs?: readonly TaskGraphStore[];
	readonly extraQueues?: readonly SchedulerDeadlockQueue[];
	readonly waitLedgers?: readonly DurableLedgerApi[];
	readonly gates?: TaskGateStore;
	readonly handoff?: SchedulerHandoffController;
	readonly lane?: string;
	readonly now?: () => string;
	readonly writerLeaseTtlMs?: number;
	readonly maxQueueDepth?: number;
	readonly sessionMaxActive?: number;
	readonly globalMaxActive?: number;
	readonly maxGraphsPerTick?: number;
	readonly maxNodesPerTick?: number;
	readonly maxEdgesPerScan?: number;
	readonly tickTimeoutMs?: number;
	readonly agingMsPerPriorityUnit?: number;
}

function schedulerError(code: SchedulerErrorCode): FoundationError {
	return new FoundationError(code, ERROR_MESSAGES[code], { retryable: RETRYABLE.has(code) });
}

function fail<T>(code: SchedulerErrorCode): ResultValue<T, FoundationError> {
	return Result.err(schedulerError(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonPayload(value: object): FoundationJsonValue {
	return value as FoundationJsonValue;
}

function asFact(record: FoundationRecord): FoundationFactRecord | undefined {
	return record.kind === "fact" ? record : undefined;
}

function ledgerCode(error: unknown): string | undefined {
	if (error instanceof DurableLedgerError || error instanceof FoundationError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return undefined;
}

function mapLedgerError(error: unknown): FoundationError {
	if (error instanceof FoundationError) return error;
	const code = ledgerCode(error);
	if (code === "scheduler_deadlock_detected") return schedulerError("scheduler_deadlock_detected");
	return schedulerError("scheduler_persistence_failed");
}

function omitUndefinedCorrelation(correlation: EventCorrelationRef): EventCorrelationRef {
	const next: EventCorrelationRef = { sessionId: correlation.sessionId };
	if (correlation.laneId !== undefined) next.laneId = correlation.laneId;
	if (correlation.taskId !== undefined) next.taskId = correlation.taskId;
	if (correlation.dispatchId !== undefined) next.dispatchId = correlation.dispatchId;
	if (correlation.attemptId !== undefined) next.attemptId = correlation.attemptId;
	if (correlation.workflowId !== undefined) next.workflowId = correlation.workflowId;
	if (correlation.askId !== undefined) next.askId = correlation.askId;
	if (correlation.goalId !== undefined) next.goalId = correlation.goalId;
	return next;
}

function queueEventPayload(entry: SchedulerQueueEntry): SchedulerQueueEventPayload {
	const payload: SchedulerQueueEventPayload = {
		schemaVersion: 1,
		queueEntryId: entry.queueEntryId,
		sessionId: entry.sessionId,
		taskId: entry.taskId,
		state: entry.state,
		revision: entry.revision,
	};
	if (entry.nodeRef !== undefined) {
		payload.nodeId = entry.nodeRef.nodeId;
		payload.graphRevision = entry.nodeRef.graphRevision;
	}
	if (entry.claimId !== undefined) payload.claimId = entry.claimId;
	if (entry.workflowId !== undefined) payload.workflowId = entry.workflowId;
	if (entry.goalId !== undefined) payload.goalId = entry.goalId;
	return payload;
}

function dispatchEventPayload(dispatch: SchedulerDispatchRecord): SchedulerDispatchEventPayload {
	const payload: SchedulerDispatchEventPayload = {
		schemaVersion: 1,
		queueEntryId: dispatch.queueEntryId,
		claimId: dispatch.claimId,
		dispatchId: dispatch.dispatchId,
		providerId: dispatch.providerId,
		providerClass: dispatch.providerClass,
		status: dispatch.status,
		revision: dispatch.revision,
	};
	if (dispatch.attemptId !== undefined) payload.attemptId = dispatch.attemptId;
	if (dispatch.reservationId !== undefined) payload.reservationId = dispatch.reservationId;
	return payload;
}

function claimReleasedPayload(
	claimId: string,
	queueEntryId: string,
	taskId: string,
	ownerId: string,
	revision: number,
	sessionId: string,
): SchedulerClaimEventPayload {
	return {
		schemaVersion: 1,
		claimId,
		queueEntryId,
		taskId,
		ownerId,
		revision,
		sessionId,
	};
}

function deadlockEventPayload(fact: SchedulerDeadlockFact): SchedulerDeadlockEventPayload {
	return {
		schemaVersion: 1,
		detectionId: fact.detectionId,
		detectedAt: fact.detectedAt,
		memberCount: fact.memberTaskIds.length,
		failedCount: fact.failedTaskIds.length,
	};
}

function uniqueKinds(kinds: readonly SchedulerWaitEdgeKind[]): readonly SchedulerWaitEdgeKind[] {
	const present = new Set(kinds);
	return SCHEDULER_WAIT_EDGE_KINDS.filter((kind) => present.has(kind));
}

function isAskWaitFact(value: unknown): value is SchedulerAskWaitFact {
	if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "ask") return false;
	if (
		value.status !== "waiting" &&
		value.status !== "answered" &&
		value.status !== "expired" &&
		value.status !== "escalated" &&
		value.status !== "cancelled"
	) {
		return false;
	}
	return (
		typeof value.waitId === "string" &&
		typeof value.sourceSessionId === "string" &&
		typeof value.targetSessionId === "string" &&
		typeof value.askId === "string"
	);
}

export function schedulerEffectivePriority(
	entry: SchedulerQueueEntry,
	nowIso: string,
	agingMsPerPriorityUnit: number = SCHEDULER_DEADLOCK_AGING_MS_PER_PRIORITY_UNIT,
): number {
	const waitingMs = Math.max(0, Date.parse(nowIso) - Date.parse(entry.enqueuedAt));
	const unit = Math.max(1, agingMsPerPriorityUnit);
	return entry.priority + Math.floor(waitingMs / unit);
}

export function schedulerOrderQueuedWork(
	entries: readonly SchedulerQueueEntry[],
	nowIso: string,
	agingMsPerPriorityUnit: number = SCHEDULER_DEADLOCK_AGING_MS_PER_PRIORITY_UNIT,
): readonly SchedulerQueueEntry[] {
	return [...entries].sort((left, right) => {
		const priorityDelta =
			schedulerEffectivePriority(right, nowIso, agingMsPerPriorityUnit) -
			schedulerEffectivePriority(left, nowIso, agingMsPerPriorityUnit);
		if (priorityDelta !== 0) return priorityDelta;
		if (left.revision !== right.revision) return left.revision - right.revision;
		if (left.enqueuedAt !== right.enqueuedAt) return left.enqueuedAt < right.enqueuedAt ? -1 : 1;
		if (left.queueEntryId !== right.queueEntryId) return left.queueEntryId < right.queueEntryId ? -1 : 1;
		return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
	});
}

function emptyTick(enabled: boolean): SchedulerDeadlockTickResult {
	return {
		enabled,
		scannedGraphs: 0,
		scannedNodes: 0,
		scannedEdges: 0,
		cycles: 0,
		failedTaskIds: [],
		facts: [],
		signals: [],
		retained: [],
		readyOrder: [],
		timedOut: false,
		errors: [],
	};
}

function detectionIdFor(memberTaskIds: readonly string[], edgeKinds: readonly SchedulerWaitEdgeKind[]): string {
	const digest = fingerprintFoundationValue({
		memberTaskIds: [...memberTaskIds],
		edgeKinds: [...edgeKinds],
	}).value;
	return `dl_${digest.slice(0, 16)}`;
}

interface CycleHitV1 {
	readonly memberTaskIds: readonly string[];
	readonly edgeKinds: readonly SchedulerWaitEdgeKind[];
	readonly cycleEdges: readonly SchedulerWaitForEdge[];
}

function findFirstCycle(edges: readonly SchedulerWaitForEdge[]): CycleHitV1 | undefined {
	const adjacency = new Map<string, SchedulerWaitForEdge[]>();
	for (const edge of edges) {
		if (edge.fromTaskId === edge.toTaskId) continue;
		const list = adjacency.get(edge.fromTaskId) ?? [];
		list.push(edge);
		adjacency.set(edge.fromTaskId, list);
	}
	for (const list of adjacency.values()) {
		list.sort((left, right) => {
			if (left.toTaskId !== right.toTaskId) return left.toTaskId < right.toTaskId ? -1 : 1;
			return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
		});
	}
	const vertices = [...new Set(edges.flatMap((edge) => [edge.fromTaskId, edge.toTaskId]))].sort();
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const parent = new Map<string, SchedulerWaitForEdge>();
	let found: CycleHitV1 | undefined;
	const visit = (node: string): boolean => {
		if (found !== undefined) return true;
		visiting.add(node);
		for (const edge of adjacency.get(node) ?? []) {
			if (visited.has(edge.toTaskId)) continue;
			if (visiting.has(edge.toTaskId)) {
				const cycleEdges: SchedulerWaitForEdge[] = [edge];
				let cursor = node;
				while (cursor !== edge.toTaskId) {
					const step = parent.get(cursor);
					if (step === undefined) break;
					cycleEdges.push(step);
					cursor = step.fromTaskId;
				}
				cycleEdges.reverse();
				const members = [...new Set(cycleEdges.flatMap((item) => [item.fromTaskId, item.toTaskId]))].sort();
				if (members.length >= 2) {
					found = {
						memberTaskIds: members,
						edgeKinds: uniqueKinds(cycleEdges.map((item) => item.kind)),
						cycleEdges,
					};
					return true;
				}
				continue;
			}
			parent.set(edge.toTaskId, edge);
			if (visit(edge.toTaskId)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const vertex of vertices) {
		if (visited.has(vertex)) continue;
		if (visit(vertex)) break;
	}
	return found;
}

function isActiveQueueState(state: SchedulerQueueEntry["state"]): boolean {
	return state === "claimed" || state === "dispatched";
}

interface ScanBudgetV1 {
	graphs: number;
	nodes: number;
	edges: number;
	steps: number;
	timedOut: boolean;
}

export class SchedulerDeadlockController {
	readonly enabled: boolean;
	private readonly sessionId: string;
	private readonly ownerId: string;
	private readonly ledger: DurableLedgerApi;
	private readonly graph: TaskGraphStore;
	private readonly extraGraphs: readonly TaskGraphStore[];
	private readonly queue: SchedulerDeadlockQueue;
	private readonly extraQueues: readonly SchedulerDeadlockQueue[];
	private readonly waitLedgers: readonly DurableLedgerApi[];
	private readonly gates: TaskGateStore | undefined;
	private readonly handoff: SchedulerHandoffController | undefined;
	private readonly lane: string;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly writerLeaseTtlMs: number;
	private readonly maxQueueDepth: number;
	private readonly sessionMaxActive: number;
	private readonly globalMaxActive: number;
	private readonly maxGraphsPerTick: number;
	private readonly maxNodesPerTick: number;
	private readonly maxEdgesPerScan: number;
	private readonly tickTimeoutMs: number;
	private readonly agingMsPerPriorityUnit: number;
	private writerLease: LedgerWriterLease | undefined;
	private facts = new Map<string, SchedulerDeadlockFact>();
	private factRevisions = new Map<string, number>();
	private eventRevisions = new Map<string, number>();
	private retained = new Map<string, SchedulerRetainedWork>();
	private inFlight: Promise<SchedulerDeadlockTickResult> | undefined;
	private fenceTimedOut = false;

	constructor(options: SchedulerDeadlockControllerOptions) {
		this.clock = runtimeClockFor(options);
		this.enabled = options.enabled ?? false;
		this.sessionId = options.sessionId;
		this.ownerId = options.ownerId;
		this.ledger = options.ledger;
		this.graph = options.graph;
		this.extraGraphs = options.extraGraphs ?? [];
		this.queue = options.queue;
		this.extraQueues = options.extraQueues ?? [];
		this.waitLedgers = options.waitLedgers ?? [options.ledger];
		this.gates = options.gates;
		this.handoff = options.handoff;
		this.lane = options.lane ?? "main";
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.writerLeaseTtlMs = options.writerLeaseTtlMs ?? 15 * 60 * 1000;
		this.maxQueueDepth = Math.max(1, options.maxQueueDepth ?? SCHEDULER_QUEUE_MAX_DEPTH);
		this.sessionMaxActive = Math.max(1, options.sessionMaxActive ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS);
		this.globalMaxActive = Math.max(1, options.globalMaxActive ?? SCHEDULER_GLOBAL_MAX_ACTIVE_ATTEMPTS);
		this.maxGraphsPerTick = Math.min(
			100,
			Math.max(1, options.maxGraphsPerTick ?? SCHEDULER_HOST_DEFAULT_MAX_GRAPHS_PER_TICK),
		);
		this.maxNodesPerTick = Math.min(
			SCHEDULER_QUEUE_MAX_DEPTH,
			Math.max(1, options.maxNodesPerTick ?? SCHEDULER_HOST_DEFAULT_MAX_NODES_PER_TICK),
		);
		this.maxEdgesPerScan = Math.max(1, options.maxEdgesPerScan ?? 1024);
		this.tickTimeoutMs = Math.max(1, options.tickTimeoutMs ?? SCHEDULER_DEADLOCK_DEFAULT_TICK_TIMEOUT_MS);
		this.agingMsPerPriorityUnit = Math.max(
			1,
			options.agingMsPerPriorityUnit ?? SCHEDULER_DEADLOCK_AGING_MS_PER_PRIORITY_UNIT,
		);
	}

	retainedWork(): readonly SchedulerRetainedWork[] {
		return [...this.retained.values()];
	}

	async reload(): Promise<ResultValue<readonly SchedulerDeadlockFact[], FoundationError>> {
		try {
			const records = await this.ledger.findFoundationRecords({
				objectType: SCHEDULER_DEADLOCK_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			this.facts = new Map();
			this.factRevisions = new Map();
			for (const record of records) {
				const fact = asFact(record);
				if (fact === undefined) continue;
				const parsed = parseSchedulerDeadlockFact(fact.payload);
				if (!parsed.ok) return parsed;
				this.facts.set(parsed.value.detectionId, serializeSchedulerDeadlockFact(parsed.value));
				this.factRevisions.set(parsed.value.detectionId, fact.revision);
			}
			return Result.ok([...this.facts.values()].map(serializeSchedulerDeadlockFact));
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
	}

	tick(): Promise<SchedulerDeadlockTickResult> {
		if (!this.enabled) return Promise.resolve(emptyTick(false));
		if (this.inFlight !== undefined) {
			if (this.fenceTimedOut) return Promise.resolve({ ...emptyTick(true), timedOut: true });
			return this.observeInFlight(this.inFlight);
		}
		const work = this.tickOnce();
		this.inFlight = work.finally(() => {
			this.inFlight = undefined;
			this.fenceTimedOut = false;
		});
		return this.observeInFlight(this.inFlight);
	}

	private observeInFlight(
		work: Promise<SchedulerDeadlockTickResult>,
	): Promise<SchedulerDeadlockTickResult> {
		return new Promise((resolve) => {
			let settled = false;
			const timer = this.clock.setTimeout(() => {
				if (settled) return;
				settled = true;
				this.fenceTimedOut = true;
				resolve({ ...emptyTick(true), timedOut: true });
			}, this.tickTimeoutMs);
			this.clock.unrefTimeout(timer);
			work.then(
				(result) => {
					this.clock.clearTimeout(timer);
					if (settled) return;
					settled = true;
					resolve(result);
				},
				(error) => {
					this.clock.clearTimeout(timer);
					if (settled) return;
					settled = true;
					resolve({
						...emptyTick(true),
						errors: [
							{
								taskId: "scheduler",
								code: error instanceof FoundationError ? error.code : "scheduler_persistence_failed",
							},
						],
					});
				},
			);
		});
	}

	private graphs(): readonly TaskGraphStore[] {
		return [this.graph, ...this.extraGraphs];
	}

	private queues(): readonly SchedulerDeadlockQueue[] {
		return [this.queue, ...this.extraQueues];
	}

	private nowIso(): string {
		return this.nowFn();
	}

	private createBudget(): ScanBudgetV1 {
		return { graphs: 0, nodes: 0, edges: 0, steps: 0, timedOut: false };
	}

	private expired(budget: ScanBudgetV1, deadlineAt: number): boolean {
		budget.steps += 1;
		if (budget.steps > SCHEDULER_DEADLOCK_SCAN_HARD_CAP) {
			budget.timedOut = true;
			return true;
		}
		if (this.clock.monotonicNow() >= deadlineAt) {
			budget.timedOut = true;
			return true;
		}
		return false;
	}

	private async tickOnce(): Promise<SchedulerDeadlockTickResult> {
		const scanned = applySchedulerEngineTransition("idle", "scanning");
		if (!scanned.ok) {
			return {
				...emptyTick(true),
				errors: [{ taskId: "scheduler", code: scanned.error.code }],
			};
		}
		const deadlineAt = this.clock.monotonicNow() + this.tickTimeoutMs;
		const budget = this.createBudget();
		const errors: SchedulerDeadlockTickError[] = [];
		const loaded = await this.reload();
		if (!loaded.ok) {
			applySchedulerEngineTransition("scanning", "idle");
			return {
				...emptyTick(true),
				timedOut: budget.timedOut,
				errors: [{ taskId: "scheduler", code: loaded.error.code }],
			};
		}
		const failed = new Set<string>();
		for (const fact of this.facts.values()) {
			for (const taskId of fact.failedTaskIds) failed.add(taskId);
		}
		for (const taskId of [...failed].sort()) {
			if (this.expired(budget, deadlineAt)) break;
			const retried = await this.failTask(taskId, deadlineAt, budget);
			if (!retried.ok) errors.push({ taskId, code: retried.error.code });
		}
		const collected = await this.collectEdges(failed, deadlineAt, budget);
		if (!collected.ok) {
			applySchedulerEngineTransition("scanning", "idle");
			return {
				...emptyTick(true),
				scannedGraphs: budget.graphs,
				scannedNodes: budget.nodes,
				scannedEdges: budget.edges,
				timedOut: budget.timedOut,
				facts: [...this.facts.values()].map(serializeSchedulerDeadlockFact),
				errors: [{ taskId: "scheduler", code: collected.error.code }, ...errors],
			};
		}
		const cycle = findFirstCycle(collected.value);
		const failedThisTick: string[] = [];
		if (cycle !== undefined) {
			const sacrificial = await this.chooseSacrificial(cycle.memberTaskIds);
			if (!sacrificial.ok) {
				errors.push({ taskId: "scheduler", code: sacrificial.error.code });
			} else {
				const fact: SchedulerDeadlockFact = {
					schemaVersion: 1,
					detectionId: detectionIdFor(cycle.memberTaskIds, cycle.edgeKinds),
					memberTaskIds: cycle.memberTaskIds,
					edgeKinds: cycle.edgeKinds,
					failedTaskIds: [sacrificial.value],
					detectedAt: this.nowIso(),
				};
				const persisted = await this.persistDeadlockFact(fact);
				if (!persisted.ok) errors.push({ taskId: sacrificial.value, code: persisted.error.code });
				else {
					failed.add(sacrificial.value);
					failedThisTick.push(sacrificial.value);
					const cancelled = await this.failTask(sacrificial.value, deadlineAt, budget);
					if (!cancelled.ok) errors.push({ taskId: sacrificial.value, code: cancelled.error.code });
				}
			}
		}
		const pressure = await this.enforceBackpressure(failed, deadlineAt, budget);
		if (!pressure.ok) errors.push({ taskId: "scheduler", code: pressure.error.code });
		applySchedulerEngineTransition("scanning", "idle");
		const snapshots = await this.snapshotAllQueues();
		if (!snapshots.ok) {
			return {
				...emptyTick(true),
				scannedGraphs: budget.graphs,
				scannedNodes: budget.nodes,
				scannedEdges: budget.edges,
				cycles: cycle === undefined ? 0 : 1,
				failedTaskIds: failedThisTick,
				facts: [...this.facts.values()].map(serializeSchedulerDeadlockFact),
				timedOut: budget.timedOut,
				errors: [{ taskId: "scheduler", code: snapshots.error.code }, ...errors],
			};
		}
		const retainedIds = new Set(this.retained.keys());
		const queued = snapshots.value.entries.filter(
			(entry) => entry.state === "queued" && !retainedIds.has(entry.queueEntryId),
		);
		const readyOrder = schedulerOrderQueuedWork(queued, this.nowIso(), this.agingMsPerPriorityUnit).map(
			(entry) => entry.queueEntryId,
		);
		return {
			enabled: true,
			scannedGraphs: budget.graphs,
			scannedNodes: budget.nodes,
			scannedEdges: budget.edges,
			cycles: cycle === undefined ? 0 : 1,
			failedTaskIds: failedThisTick,
			facts: [...this.facts.values()].map(serializeSchedulerDeadlockFact),
			signals: pressure.ok ? pressure.value.signals : [],
			retained: [...this.retained.values()],
			readyOrder,
			timedOut: budget.timedOut,
			errors,
		};
	}

	private async snapshotAllQueues(): Promise<
		ResultValue<
			{
				readonly entries: SchedulerQueueEntry[];
				readonly claims: { claimId: string; ownerId: string; taskId: string; queueEntryId: string }[];
				readonly dispatches: SchedulerDispatchRecord[];
			},
			FoundationError
		>
	> {
		const entries: SchedulerQueueEntry[] = [];
		const claims: { claimId: string; ownerId: string; taskId: string; queueEntryId: string }[] = [];
		const dispatches: SchedulerDispatchRecord[] = [];
		for (const store of this.queues()) {
			const snapshot = await store.snapshot();
			if (!snapshot.ok) return snapshot;
			entries.push(...snapshot.value.entries.map(serializeSchedulerQueueEntry));
			for (const claim of snapshot.value.claims) {
				claims.push({
					claimId: claim.claimId,
					ownerId: claim.ownerId,
					taskId: claim.taskId,
					queueEntryId: claim.queueEntryId,
				});
			}
			dispatches.push(...snapshot.value.dispatches.map(serializeSchedulerDispatchRecord));
		}
		return Result.ok({ entries, claims, dispatches });
	}

	private async collectEdges(
		failed: ReadonlySet<string>,
		deadlineAt: number,
		budget: ScanBudgetV1,
	): Promise<ResultValue<readonly SchedulerWaitForEdge[], FoundationError>> {
		const edges: SchedulerWaitForEdge[] = [];
		const push = (edge: SchedulerWaitForEdge): boolean => {
			if (failed.has(edge.fromTaskId) || failed.has(edge.toTaskId)) return !budget.timedOut;
			if (this.expired(budget, deadlineAt) || budget.edges >= this.maxEdgesPerScan) {
				budget.timedOut = budget.timedOut || budget.edges >= this.maxEdgesPerScan;
				return false;
			}
			edges.push(edge);
			budget.edges += 1;
			return true;
		};
		const snapshots = await this.snapshotAllQueues();
		if (!snapshots.ok) return snapshots;
		const knownTasks = new Set<string>();
		const tasksBySession = new Map<string, Set<string>>();
		const addTask = (sessionId: string, taskId: string): void => {
			knownTasks.add(taskId);
			const bucket = tasksBySession.get(sessionId) ?? new Set<string>();
			bucket.add(taskId);
			tasksBySession.set(sessionId, bucket);
		};
		for (const entry of snapshots.value.entries) addTask(entry.sessionId, entry.taskId);
		const listedGraphs: TaskGraphRecord[] = [];
		for (const store of this.graphs()) {
			if (this.expired(budget, deadlineAt) || budget.graphs >= this.maxGraphsPerTick) break;
			const listed = store.list({ limit: this.maxGraphsPerTick });
			for (const graph of listed.graphs) {
				if (this.expired(budget, deadlineAt) || budget.graphs >= this.maxGraphsPerTick) break;
				budget.graphs += 1;
				listedGraphs.push(graph);
				addTask(graph.sessionId, graph.taskId);
			}
		}
		for (const graph of listedGraphs) {
			for (const node of graph.nodes) {
				if (this.expired(budget, deadlineAt) || budget.nodes >= this.maxNodesPerTick) break;
				budget.nodes += 1;
				if (failed.has(graph.taskId)) continue;
				if (node.availability === "waiting_dependencies") {
					for (const dependency of node.blockingNodeIds) {
						if (!push({ fromTaskId: graph.taskId, toTaskId: dependency, kind: "dependsOn" })) break;
					}
				}
				if (node.availability === "waiting_gate" && node.gateRef !== undefined) {
					if (!push({ fromTaskId: graph.taskId, toTaskId: node.gateRef.stageId, kind: "gate" })) break;
				}
			}
			if (budget.timedOut || budget.nodes >= this.maxNodesPerTick) break;
		}
		if (this.gates !== undefined && !budget.timedOut) {
			const listed = this.gates.list({ status: "pending", limit: 100 });
			for (const gate of listed.gates) {
				if (this.expired(budget, deadlineAt)) break;
				if (failed.has(gate.taskId)) continue;
				if (!push({ fromTaskId: gate.taskId, toTaskId: gate.stageId, kind: "gate" })) break;
			}
		}
		if (!budget.timedOut) {
			const asks = await this.collectAskWaits(deadlineAt, budget);
			if (!asks.ok) return asks;
			for (const wait of asks.value) {
				if (this.expired(budget, deadlineAt)) break;
				const sources = [...(tasksBySession.get(wait.sourceSessionId) ?? [])].sort();
				const targets = [...(tasksBySession.get(wait.targetSessionId) ?? [])].sort();
				for (const fromTaskId of sources) {
					for (const toTaskId of targets) {
						if (fromTaskId === toTaskId) continue;
						if (!push({ fromTaskId, toTaskId, kind: "ask" })) break;
					}
					if (budget.timedOut || budget.edges >= this.maxEdgesPerScan) break;
				}
			}
		}
		if (this.handoff !== undefined && !budget.timedOut) {
			const offered = await this.handoff.snapshot();
			if (!offered.ok) return offered;
			const ownerTasks = new Map<string, string[]>();
			for (const entry of snapshots.value.entries) {
				if (!isActiveQueueState(entry.state) || entry.claimId === undefined) continue;
				const claim = snapshots.value.claims.find((item) => item.claimId === entry.claimId);
				if (claim === undefined) continue;
				const list = ownerTasks.get(claim.ownerId) ?? [];
				list.push(entry.taskId);
				ownerTasks.set(claim.ownerId, list);
			}
			for (const transfer of offered.value.transfers) {
				if (this.expired(budget, deadlineAt)) break;
				if (transfer.state !== "offered" || failed.has(transfer.taskId)) continue;
				const targets = ownerTasks.get(transfer.toOwnerId) ?? [];
				if (targets.length === 0 && knownTasks.has(transfer.toOwnerId) && transfer.toOwnerId !== transfer.taskId) {
					if (!push({ fromTaskId: transfer.taskId, toTaskId: transfer.toOwnerId, kind: "handoff" })) break;
					continue;
				}
				for (const toTaskId of [...new Set(targets)].sort()) {
					if (toTaskId === transfer.taskId) continue;
					if (!push({ fromTaskId: transfer.taskId, toTaskId, kind: "handoff" })) break;
				}
			}
		}
		if (!budget.timedOut) {
			for (const entry of snapshots.value.entries) {
				if (this.expired(budget, deadlineAt)) break;
				if (!isActiveQueueState(entry.state) || entry.claimId === undefined || failed.has(entry.taskId)) continue;
				const claim = snapshots.value.claims.find((item) => item.claimId === entry.claimId);
				if (claim === undefined || claim.ownerId === entry.taskId) continue;
				if (!knownTasks.has(claim.ownerId)) continue;
				if (!push({ fromTaskId: entry.taskId, toTaskId: claim.ownerId, kind: "claim" })) break;
			}
		}
		return Result.ok(edges);
	}

	private async collectAskWaits(
		deadlineAt: number,
		budget: ScanBudgetV1,
	): Promise<ResultValue<readonly SchedulerAskWaitFact[], FoundationError>> {
		const latest = new Map<string, { readonly revision: number; readonly payload: SchedulerAskWaitFact }>();
		for (const ledger of this.waitLedgers) {
			if (this.expired(budget, deadlineAt)) break;
			let records: FoundationRecord[];
			try {
				records = await ledger.findFoundationRecords({
					objectType: SCHEDULER_MESSAGE_OBJECT_TYPES.wait,
					kind: "fact",
					order: "oldestFirst",
					includePruned: true,
				});
			} catch (error) {
				return Result.err(mapLedgerError(error));
			}
			for (const record of records) {
				if (this.expired(budget, deadlineAt)) break;
				const fact = asFact(record);
				if (fact === undefined || !isAskWaitFact(fact.payload)) continue;
				const key = `${fact.payload.sourceSessionId}\0${fact.objectId}`;
				const previous = latest.get(key);
				if (previous !== undefined && fact.revision < previous.revision) continue;
				latest.set(key, { revision: fact.revision, payload: fact.payload });
			}
		}
		return Result.ok(
			[...latest.values()]
				.filter((item) => item.payload.status === "waiting")
				.map((item) => item.payload),
		);
	}

	private async chooseSacrificial(
		memberTaskIds: readonly string[],
	): Promise<ResultValue<string, FoundationError>> {
		const snapshots = await this.snapshotAllQueues();
		if (!snapshots.ok) return snapshots;
		const ranked = [...memberTaskIds].map((taskId) => {
			const owned = snapshots.value.entries.filter(
				(entry) => entry.taskId === taskId && !isSchedulerQueueTerminal(entry.state),
			);
			let revision = Number.MAX_SAFE_INTEGER;
			let queueEntryId = "";
			for (const entry of owned) {
				if (entry.revision < revision || (entry.revision === revision && entry.queueEntryId < queueEntryId)) {
					revision = entry.revision;
					queueEntryId = entry.queueEntryId;
				}
			}
			return { taskId, revision, queueEntryId };
		});
		ranked.sort((left, right) => {
			if (left.revision !== right.revision) return left.revision - right.revision;
			if (left.queueEntryId !== right.queueEntryId) {
				if (left.queueEntryId === "") return 1;
				if (right.queueEntryId === "") return -1;
				return left.queueEntryId < right.queueEntryId ? -1 : 1;
			}
			return left.taskId < right.taskId ? -1 : 1;
		});
		const chosen = ranked[0]?.taskId ?? memberTaskIds[0];
		if (chosen === undefined) return fail("scheduler_not_found");
		return Result.ok(chosen);
	}

	private async failTask(
		taskId: string,
		deadlineAt: number,
		budget: ScanBudgetV1,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.handoff !== undefined) {
			const offered = await this.handoff.snapshot();
			if (!offered.ok) return offered;
			for (const transfer of offered.value.transfers) {
				if (this.expired(budget, deadlineAt)) break;
				if (transfer.taskId !== taskId || transfer.state !== "offered") continue;
				const decided = await this.handoff.decide(transfer.transferId, "cancelled");
				if (!decided.ok) return decided;
			}
		}
		if (this.gates !== undefined) {
			const listed = this.gates.list({ taskId, status: "pending", limit: 100 });
			for (const gate of listed.gates) {
				if (this.expired(budget, deadlineAt)) break;
				const request: TaskGateDecisionRequest = {
					gateId: gate.gateId,
					reasonCode: "deadlock",
					clientRequestId: `scheduler-deadlock-${taskId}-${gate.gateId}`,
				};
				try {
					this.gates.reject(request);
				} catch (error) {
					return Result.err(
						error instanceof FoundationError ? error : schedulerError("scheduler_persistence_failed"),
					);
				}
			}
		}
		for (const store of this.queues()) {
			if (this.expired(budget, deadlineAt)) break;
			const snapshot = await store.snapshot();
			if (!snapshot.ok) return snapshot;
			for (const entry of snapshot.value.entries) {
				if (this.expired(budget, deadlineAt)) break;
				if (entry.taskId !== taskId || isSchedulerQueueTerminal(entry.state)) continue;
				const cancelled = await this.failQueueEntry(
					entry,
					snapshot.value.dispatches.filter((dispatch) => dispatch.queueEntryId === entry.queueEntryId),
					snapshot.value.claims.find((claim) => claim.claimId === entry.claimId),
				);
				if (!cancelled.ok) return cancelled;
			}
		}
		return Result.ok(undefined);
	}

	private async failQueueEntry(
		entry: SchedulerQueueEntry,
		dispatches: readonly SchedulerDispatchRecord[],
		claim: { claimId: string; ownerId: string; revision: number } | undefined,
	): Promise<ResultValue<void, FoundationError>> {
		if (entry.sessionId !== this.sessionId) return Result.ok(undefined);
		const nextEntry: SchedulerQueueEntry = {
			...serializeSchedulerQueueEntry(entry),
			state: "cancelled",
			revision: entry.revision + 1,
		};
		const applied = applySchedulerQueueTransition(entry, nextEntry);
		if (!applied.ok) return applied;
		const cancelledDispatches: SchedulerDispatchRecord[] = [];
		for (const dispatch of dispatches) {
			if (dispatch.status === "settled" || dispatch.status === "cancelled" || dispatch.status === "expired") {
				continue;
			}
			const candidate: SchedulerDispatchRecord = {
				...serializeSchedulerDispatchRecord(dispatch),
				status: "cancelled",
				revision: dispatch.revision + 1,
			};
			const appliedDispatch = applySchedulerDispatchTransition(dispatch, candidate);
			if (!appliedDispatch.ok) return appliedDispatch;
			cancelledDispatches.push(appliedDispatch.value);
		}
		return this.writeQueueCancel(applied.value, claim, cancelledDispatches);
	}

	private async writeQueueCancel(
		entry: SchedulerQueueEntry,
		claim: { claimId: string; ownerId: string; revision: number } | undefined,
		dispatches: readonly SchedulerDispatchRecord[],
	): Promise<ResultValue<void, FoundationError>> {
		for (const dispatch of dispatches) {
			const expected =
				(await this.revisionOf("scheduler.dispatch", dispatch.dispatchId)) ?? dispatch.revision;
			const written = await this.appendFact(
				"scheduler.dispatch",
				dispatch.dispatchId,
				serializeSchedulerDispatchRecord(dispatch),
				`scheduler.dispatch:${dispatch.dispatchId}:${dispatch.revision}`,
				expected,
				{
					sessionId: this.sessionId,
					taskId: entry.taskId,
					dispatchId: dispatch.dispatchId,
					...(dispatch.attemptId === undefined ? {} : { attemptId: dispatch.attemptId }),
				},
			);
			if (!written.ok) return written;
			const eventId = `evt_dispatch_${dispatch.dispatchId}_${dispatch.revision}`;
			const correlation: EventCorrelationRef = {
				sessionId: this.sessionId,
				taskId: entry.taskId,
				dispatchId: dispatch.dispatchId,
				...(dispatch.attemptId === undefined ? {} : { attemptId: dispatch.attemptId }),
			};
			const payload = dispatchEventPayload(dispatch);
			const event = await this.writeCatalogEvent(
				"scheduler.dispatch_transitioned",
				eventId,
				correlation,
				payload,
				`scheduler.dispatch_transitioned:${dispatch.dispatchId}:${dispatch.revision}`,
				(sequence) => {
					createDurableEvent({
						category: "scheduler.dispatch_transitioned",
						eventId,
						streamId: this.sessionId,
						sequence,
						timestamp: this.nowIso(),
						correlation: { ...omitUndefinedCorrelation(correlation), sessionId: this.sessionId },
						payload,
					});
				},
			);
			if (!event.ok) return event;
		}
		const expected = (await this.revisionOf(SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE, entry.queueEntryId)) ?? entry.revision;
		const written = await this.appendFact(
			SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
			entry.queueEntryId,
			serializeSchedulerQueueEntry(entry),
			`scheduler.queue_entry:${entry.queueEntryId}:${entry.revision}`,
			expected,
			{ sessionId: entry.sessionId, taskId: entry.taskId },
		);
		if (!written.ok) return written;
		const queueEventId = `evt_queue_${entry.queueEntryId}_${entry.revision}`;
		const queueCorrelation: EventCorrelationRef = { sessionId: entry.sessionId, taskId: entry.taskId };
		const queuePayload = queueEventPayload(entry);
		const event = await this.writeCatalogEvent(
			"scheduler.queue_transitioned",
			queueEventId,
			queueCorrelation,
			queuePayload,
			`scheduler.queue_transitioned:${entry.queueEntryId}:${entry.revision}`,
			(sequence) => {
				createDurableEvent({
					category: "scheduler.queue_transitioned",
					eventId: queueEventId,
					streamId: this.sessionId,
					sequence,
					timestamp: this.nowIso(),
					correlation: { ...omitUndefinedCorrelation(queueCorrelation), sessionId: this.sessionId },
					payload: queuePayload,
				});
			},
		);
		if (!event.ok) return event;
		if (claim === undefined) return Result.ok(undefined);
		const claimEventId = `evt_claim_${claim.claimId}_${claim.revision}_released`;
		const claimCorrelation: EventCorrelationRef = { sessionId: this.sessionId, taskId: entry.taskId };
		const claimPayload = claimReleasedPayload(
			claim.claimId,
			entry.queueEntryId,
			entry.taskId,
			claim.ownerId,
			claim.revision,
			this.sessionId,
		);
		return this.writeCatalogEvent(
			"scheduler.claim_released",
			claimEventId,
			claimCorrelation,
			claimPayload,
			`scheduler.claim_released:${claim.claimId}:${claim.revision}`,
			(sequence) => {
				createDurableEvent({
					category: "scheduler.claim_released",
					eventId: claimEventId,
					streamId: this.sessionId,
					sequence,
					timestamp: this.nowIso(),
					correlation: { ...omitUndefinedCorrelation(claimCorrelation), sessionId: this.sessionId },
					payload: claimPayload,
				});
			},
		);
	}

	private async persistDeadlockFact(
		fact: SchedulerDeadlockFact,
	): Promise<ResultValue<SchedulerDeadlockFact, FoundationError>> {
		const serialized = serializeSchedulerDeadlockFact(fact);
		const existing = this.facts.get(serialized.detectionId);
		if (existing !== undefined) {
			return Result.ok(serializeSchedulerDeadlockFact(existing));
		}
		const expectedRevision = this.factRevisions.get(serialized.detectionId) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_DEADLOCK_OBJECT_TYPE,
			serialized.detectionId,
			serialized,
			`scheduler.deadlock:${serialized.detectionId}:${serialized.detectedAt}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: serialized.failedTaskIds[0] },
		);
		if (!written.ok) return written;
		this.facts.set(serialized.detectionId, serialized);
		this.factRevisions.set(serialized.detectionId, expectedRevision + (written.value.replayed ? 0 : 1));
		const eventId = `evt_deadlock_${serialized.detectionId}`;
		const deadlockCorrelation: EventCorrelationRef = {
			sessionId: this.sessionId,
			taskId: serialized.failedTaskIds[0],
		};
		const deadlockPayload = deadlockEventPayload(serialized);
		const event = await this.writeCatalogEvent(
			"scheduler.deadlock_detected",
			eventId,
			deadlockCorrelation,
			deadlockPayload,
			`scheduler.deadlock_detected:${serialized.detectionId}`,
			(sequence) => {
				createDurableEvent({
					category: "scheduler.deadlock_detected",
					eventId,
					streamId: this.sessionId,
					sequence,
					timestamp: this.nowIso(),
					correlation: { ...omitUndefinedCorrelation(deadlockCorrelation), sessionId: this.sessionId },
					payload: deadlockPayload,
				});
			},
		);
		if (!event.ok) return event;
		return Result.ok(serialized);
	}

	private async enforceBackpressure(
		failed: ReadonlySet<string>,
		deadlineAt: number,
		budget: ScanBudgetV1,
	): Promise<ResultValue<{ signals: SchedulerBackpressureSignal[] }, FoundationError>> {
		const snapshots = await this.snapshotAllQueues();
		if (!snapshots.ok) return snapshots;
		const live = snapshots.value.entries.filter((entry) => !isSchedulerQueueTerminal(entry.state));
		const liveKeys = new Set(
			live.map((entry) => schedulerQueueBusinessKey(entry.sessionId, entry.taskId, entry.nodeRef)),
		);
		const signals: SchedulerBackpressureSignal[] = [];
		const emit = (limit: SchedulerBackpressureLimit, sessionId: string | undefined, retained: number): void => {
			const existing = signals.find(
				(signal) => signal.limit === limit && signal.sessionId === sessionId,
			);
			if (existing !== undefined) return;
			signals.push({
				code: "scheduler_backpressure",
				limit,
				...(sessionId === undefined ? {} : { sessionId }),
				retained,
			});
		};
		const admit = async (
			candidate: SchedulerQueueEntry,
		): Promise<ResultValue<void, FoundationError>> => {
			const key = schedulerQueueBusinessKey(candidate.sessionId, candidate.taskId, candidate.nodeRef);
			if (liveKeys.has(key)) {
				this.retained.delete(candidate.queueEntryId);
				return Result.ok(undefined);
			}
			if (live.length >= this.maxQueueDepth) {
				this.retain(candidate, "queue_depth");
				emit("queue_depth", candidate.sessionId, this.retained.size);
				return Result.ok(undefined);
			}
			if (candidate.sessionId !== this.sessionId) return Result.ok(undefined);
			const enqueued = await this.queue.enqueue(candidate);
			if (!enqueued.ok) {
				if (enqueued.error.code === "scheduler_backpressure") {
					this.retain(candidate, "queue_depth");
					emit("queue_depth", candidate.sessionId, this.retained.size);
					return Result.ok(undefined);
				}
				return enqueued;
			}
			if (!enqueued.value.idempotent) {
				live.push(enqueued.value.entry);
				liveKeys.add(key);
			}
			this.retained.delete(candidate.queueEntryId);
			return Result.ok(undefined);
		};
		const retryDepth = schedulerOrderQueuedWork(
			[...this.retained.values()]
				.filter((item) => item.reason === "queue_depth")
				.map((item) => item.candidate),
			this.nowIso(),
			this.agingMsPerPriorityUnit,
		);
		for (const candidate of retryDepth) {
			if (this.expired(budget, deadlineAt)) break;
			const retried = await admit(candidate);
			if (!retried.ok) return retried;
		}
		const listed: TaskGraphRecord[] = [];
		for (const store of this.graphs()) {
			if (this.expired(budget, deadlineAt)) break;
			listed.push(...store.list({ limit: this.maxGraphsPerTick }).graphs);
		}
		for (const graph of listed) {
			for (const node of graph.nodes) {
				if (this.expired(budget, deadlineAt) || budget.nodes >= this.maxNodesPerTick) break;
				if (node.status !== "pending" || node.availability !== "ready") continue;
				if (failed.has(graph.taskId)) continue;
				const nodeRef = {
					taskId: graph.taskId,
					graphRevision: graph.graphRevision,
					nodeId: node.nodeId,
				};
				const candidate: SchedulerQueueEntry = {
					schemaVersion: 1,
					queueEntryId: `queue_${fingerprintFoundationValue(nodeRef).value}`,
					sessionId: graph.sessionId,
					taskId: graph.taskId,
					nodeRef,
					state: "queued",
					priority: 0,
					attemptsUsed: 0,
					enqueuedAt: graph.createdAt,
					revision: 0,
				};
				const admitted = await admit(candidate);
				if (!admitted.ok) return admitted;
			}
		}
		const active = live.filter((entry) => isActiveQueueState(entry.state));
		const queued = schedulerOrderQueuedWork(
			live.filter((entry) => entry.state === "queued"),
			this.nowIso(),
			this.agingMsPerPriorityUnit,
		);
		for (const entry of queued) {
			if (this.expired(budget, deadlineAt)) break;
			const sessionActive = active.filter((item) => item.sessionId === entry.sessionId).length;
			if (sessionActive >= this.sessionMaxActive) {
				this.retain(entry, "session_active");
				emit("session_active", entry.sessionId, this.retained.size);
				continue;
			}
			if (active.length >= this.globalMaxActive) {
				this.retain(entry, "global_active");
				emit("global_active", undefined, this.retained.size);
				continue;
			}
			this.retained.delete(entry.queueEntryId);
		}
		return Result.ok({ signals });
	}

	private retain(candidate: SchedulerQueueEntry, reason: SchedulerBackpressureLimit): void {
		this.retained.set(candidate.queueEntryId, {
			queueEntryId: candidate.queueEntryId,
			sessionId: candidate.sessionId,
			taskId: candidate.taskId,
			reason,
			candidate: serializeSchedulerQueueEntry(candidate),
		});
	}

	private async revisionOf(objectType: string, objectId: string): Promise<number | undefined> {
		try {
			return await this.ledger.getFoundationRevision(objectType, objectId);
		} catch {
			return undefined;
		}
	}

	private async writeCatalogEvent(
		category:
			| "scheduler.queue_transitioned"
			| "scheduler.dispatch_transitioned"
			| "scheduler.claim_released"
			| "scheduler.deadlock_detected",
		eventId: string,
		correlation: EventCorrelationRef,
		payload: object,
		clientRequestId: string,
		validate: (sequence: number) => void,
	): Promise<ResultValue<void, FoundationError>> {
		let sequence = 1;
		try {
			sequence = (await this.ledger.getLedgerRevision()) + 1;
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
		try {
			validate(sequence < 1 ? 1 : sequence);
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
		const expectedRevision = this.eventRevisions.get(`${category}:${eventId}`) ?? 0;
		const written = await this.appendFact(category, eventId, payload, clientRequestId, expectedRevision, {
			...correlation,
			sessionId: this.sessionId,
		});
		if (!written.ok) return written;
		this.eventRevisions.set(`${category}:${eventId}`, expectedRevision + (written.value.replayed ? 0 : 1));
		return Result.ok(undefined);
	}

	private async appendFact(
		objectType: string,
		objectId: string,
		payload: object,
		clientRequestId: string,
		expectedRevision: number,
		correlation: EventCorrelationRef,
	): Promise<ResultValue<{ replayed: boolean }, FoundationError>> {
		try {
			const lease = await this.ensureWriterLease();
			const result = await this.ledger.appendFoundationRecord({
				schemaVersion: 1,
				kind: "fact",
				id: `sched_${objectType.replaceAll(".", "_")}_${objectId}_${clientRequestId}`,
				lane: this.lane,
				objectType,
				objectId,
				clientRequestId,
				expectedRevision,
				payload: jsonPayload(payload),
				correlation: {
					...omitUndefinedCorrelation(correlation),
					sessionId: this.sessionId,
					laneId: this.lane,
				},
				fencingToken: lease.fencingToken,
			});
			if (result.record.kind !== "fact") return fail("scheduler_persistence_failed");
			return Result.ok({ replayed: result.replayed });
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
	}

	private async ensureWriterLease(): Promise<LedgerWriterLease> {
		const nowMs = this.clock.wallNow();
		const current = await this.ledger.getWriterLease();
		if (
			this.writerLease !== undefined &&
			current?.fencingToken === this.writerLease.fencingToken &&
			current.expiresAt > nowMs + Math.min(WRITER_LEASE_REFRESH_MS, Math.floor(this.writerLeaseTtlMs / 4))
		) {
			return this.writerLease;
		}
		if (current?.ownerId === this.ownerId && current.expiresAt > nowMs) {
			try {
				this.writerLease = await this.ledger.renewWriterLease({
					fencingToken: current.fencingToken,
					ttlMs: this.writerLeaseTtlMs,
				});
				return this.writerLease;
			} catch (error) {
				const code = ledgerCode(error);
				if (
					code !== "session_writer_lease_expired" &&
					code !== "session_writer_fencing_token" &&
					code !== "session_writer_lease_lost"
				) {
					throw error;
				}
				this.writerLease = undefined;
			}
		}
		this.writerLease = await this.ledger.acquireWriterLease({
			ownerId: this.ownerId,
			ttlMs: this.writerLeaseTtlMs,
		});
		return this.writerLease;
	}
}
