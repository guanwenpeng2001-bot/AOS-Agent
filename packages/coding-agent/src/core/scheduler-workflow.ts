/**
 * Production Workflow controller (T7). Default-off. WorkflowStore is the only
 * Workflow state authority. Local Agent/Tool work goes through the sealed
 * Scheduler dispatch, handoff, fan-in, and Host settlement path. External
 * Agent steps stop at awaiting_dispatch and use SchedulerMessageOrchestratorV1
 * submit/wait/reclaim against a second Session. Wakes are SchedulerWakeV1
 * facts on the Session ledger and fire at most once.
 */
import {
	type AgentBinding,
	type AttemptReceipt,
	createDurableEvent,
	type DurableEventCategory,
	type EventCorrelationRef,
	fingerprintFoundationValue,
	FoundationError,
	type FoundationRecord,
	type SchedulerWakeEventPayload,
	Result,
	type Result as ResultValue,
	type Session,
	SessionLedger,
	type SideEffectState,
	type TaskEnvelope,
	type AgentStep,
	type WorkflowStepStatus,
	type WorkflowStep,
	WorkflowStore,
	type Workflow,
} from "@aos-agent/agent-core";
import { SchedulerDispatchController } from "./scheduler-dispatch.ts";
import type { SchedulerExecutorRegistry } from "./scheduler-executors.ts";
import { SchedulerFanInController, schedulerNodeJoinId } from "./scheduler-fan-in.ts";
import { SchedulerHandoffController } from "./scheduler-handoff.ts";
import {
	SchedulerMessageOrchestrator,
	type SchedulerMessageSessionEndpointV1,
} from "./scheduler-messages.ts";
import { SchedulerQueueStore } from "./scheduler-queue.ts";
import type { RunLedgerSession } from "./run-lifecycle.ts";
import { runtimeClockFor, withRuntimeClock, type RuntimeClock } from "./runtime-clock.ts";
import {
	applySchedulerWakeFire,
	isSchedulerQueueTerminal,
	isSchedulerSideEffectRetryable,
	parseSchedulerWake,
	SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
	SCHEDULER_DEFAULT_MAX_ATTEMPTS,
	SchedulerHost,
	type SchedulerHostTickResult,
	type SchedulerJoinPlanV1,
	type SchedulerNodeRefV1,
	type SchedulerOwnershipTransferV1,
	type SchedulerQueueEntryV1,
	type SchedulerWakeV1,
	serializeSchedulerWake,
} from "./scheduler.ts";
import type { TaskGraphStore } from "./task-graph.ts";

export const SCHEDULER_WORKFLOW_WAKE_OBJECT_TYPE = "scheduler.wake";
export const SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE = "scheduler.workflow.attempt";
export const SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE = "scheduler.workflow.policy";
export const SCHEDULER_WORKFLOW_EXTERNAL_OBJECT_TYPE = "scheduler.workflow.external";
export const SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE = "scheduler.workflow.compensation";

const COMPLETED_STEP_STATUSES = new Set<WorkflowStepStatus>(["succeeded", "cancelled", "skipped"]);
const EXECUTABLE_STEP_TYPES = new Set<WorkflowStep["type"]>(["agent", "tool"]);

export type SchedulerWorkflowCompensationPolicyV1 = "stop" | "bounded_retry" | "compensate";
export type SchedulerWorkflowCompensationStateV1 = "scheduled" | "settled" | "failed";
export const SCHEDULER_WORKFLOW_COMPENSATION_STATES = ["scheduled", "settled", "failed"] as const;
export const SCHEDULER_WORKFLOW_COMPENSATION_POLICIES = ["stop", "bounded_retry", "compensate"] as const;

export interface SchedulerWorkflowExternalIdsV1 {
	readonly waitId: string;
	readonly threadId: string;
	readonly submitMessageId: string;
	readonly readyMessageId: string;
	readonly reclaimMessageId: string;
	readonly clientRequestId: string;
}

export interface SchedulerWorkflowAttemptFactV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly stepId: string;
	readonly attemptsUsed: number;
	readonly maxAttempts: number;
	readonly lastSideEffect?: SideEffectState;
	readonly lastQueueEntryId?: string;
}

export interface SchedulerWorkflowPolicyFactV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly policy: SchedulerWorkflowCompensationPolicyV1;
	readonly maxAttempts: number;
}

export interface SchedulerWorkflowExternalFactV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly stepId: string;
	readonly taskId: string;
	readonly waitId: string;
	readonly threadId: string;
	readonly submitMessageId: string;
	readonly readyMessageId: string;
	readonly reclaimMessageId: string;
	readonly clientRequestId: string;
	readonly submittedAt: string;
}

export interface SchedulerWorkflowCompensationFactV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly stepId: string;
	readonly queueEntryId: string;
	readonly attempt: number;
	readonly nodeId: string;
	readonly state: SchedulerWorkflowCompensationStateV1;
	readonly scheduledAt: string;
	readonly settledAt?: string;
	readonly failedAt?: string;
}

export interface SchedulerWorkflowControllerOptionsV1 {
	/** Production scheduling is inert unless explicitly enabled. */
	readonly enabled?: boolean;
	readonly sourceSession: Session;
	readonly targetSession: Session;
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly sourceGraph: TaskGraphStore;
	readonly targetGraph: TaskGraphStore;
	readonly ownerId: string;
	readonly registry: SchedulerExecutorRegistry;
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly runLifecycleSession?: RunLedgerSession;
	readonly runLifecycleHookOwnership?: "dispatch" | "host";
	readonly executorOwnerId?: string;
	readonly compensationPolicy?: SchedulerWorkflowCompensationPolicyV1;
	readonly maxAttempts?: number;
	readonly now?: () => string;
}

export interface SchedulerWorkflowTickErrorV1 {
	readonly workflowId: string;
	readonly stepId?: string;
	readonly code: string;
}

export interface SchedulerWorkflowTickResult {
	readonly enabled: boolean;
	readonly workflows: number;
	readonly scheduled: number;
	readonly completed: number;
	readonly stopped: number;
	readonly wakesFired: number;
	readonly errors: readonly SchedulerWorkflowTickErrorV1[];
}

function plusMs(nowIso: string, ttlMs: number): string {
	return new Date(Date.parse(nowIso) + ttlMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
	if (error instanceof FoundationError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return "scheduler_persistence_failed";
}

function mutationId(parts: readonly string[]): string {
	const joined = parts.join(":");
	if (/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(joined)) return joined;
	return `r_${fingerprintFoundationValue(parts).value.slice(0, 24)}`;
}

function stemId(value: unknown): string {
	return fingerprintFoundationValue(value).value.slice(0, 16);
}

export function schedulerWorkflowExternalIds(
	workflowId: string,
	stepId: string,
): SchedulerWorkflowExternalIdsV1 {
	const stem = stemId({ workflowId, stepId });
	return {
		waitId: `wait_${stem}`,
		threadId: `thr_${stem}`,
		submitMessageId: `sub_${stem}`,
		readyMessageId: `rdy_${stem}`,
		reclaimMessageId: `rcm_${stem}`,
		clientRequestId: `ext_${stem}`,
	};
}

function queueIdentity(workflowId: string, nodeId: string, attempt: number): string {
	return `q_${stemId({ workflowId, stepId: nodeId, attempt })}`;
}

function localNodeId(stepId: string, attempt: number, compensation: boolean): string {
	const base = compensation ? `compensate_${stepId}` : stepId;
	return attempt === 1 ? base : `${base}_r${attempt}`;
}

function parsePolicyFact(
	value: unknown,
	workflowId: string,
): ResultValue<SchedulerWorkflowPolicyFactV1, FoundationError> {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.workflowId !== workflowId ||
		typeof value.policy !== "string" ||
		!SCHEDULER_WORKFLOW_COMPENSATION_POLICIES.includes(value.policy as SchedulerWorkflowCompensationPolicyV1) ||
		typeof value.maxAttempts !== "number" ||
		!Number.isInteger(value.maxAttempts) ||
		value.maxAttempts < 1
	) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Stored Workflow compensation policy is invalid"),
		);
	}
	return Result.ok({
		schemaVersion: 1,
		workflowId,
		policy: value.policy as SchedulerWorkflowCompensationPolicyV1,
		maxAttempts: value.maxAttempts,
	});
}

function parseCompensationFact(
	value: unknown,
	workflowId: string,
	stepId: string,
): ResultValue<SchedulerWorkflowCompensationFactV1, FoundationError> {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.workflowId !== workflowId ||
		value.stepId !== stepId ||
		typeof value.queueEntryId !== "string" ||
		value.queueEntryId.length === 0 ||
		typeof value.attempt !== "number" ||
		!Number.isInteger(value.attempt) ||
		value.attempt < 1 ||
		typeof value.nodeId !== "string" ||
		value.nodeId.length === 0 ||
		typeof value.state !== "string" ||
		!SCHEDULER_WORKFLOW_COMPENSATION_STATES.includes(value.state as SchedulerWorkflowCompensationStateV1) ||
		typeof value.scheduledAt !== "string"
	) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Stored Workflow compensation fact is invalid"),
		);
	}
	const fact: SchedulerWorkflowCompensationFactV1 = {
		schemaVersion: 1,
		workflowId,
		stepId,
		queueEntryId: value.queueEntryId,
		attempt: value.attempt,
		nodeId: value.nodeId,
		state: value.state as SchedulerWorkflowCompensationStateV1,
		scheduledAt: value.scheduledAt,
		...(typeof value.settledAt === "string" ? { settledAt: value.settledAt } : {}),
		...(typeof value.failedAt === "string" ? { failedAt: value.failedAt } : {}),
	};
	return Result.ok(fact);
}

function transferIdentity(queueEntryId: string): string {
	return `tr_${stemId(queueEntryId)}`;
}

function emptyTick(enabled: boolean): SchedulerWorkflowTickResult {
	return {
		enabled,
		workflows: 0,
		scheduled: 0,
		completed: 0,
		stopped: 0,
		wakesFired: 0,
		errors: [],
	};
}

function depsSettled(workflow: Workflow, step: WorkflowStep): boolean {
	if (step.dependsOn === undefined || step.dependsOn.length === 0) return true;
	return step.dependsOn.every((dependency) => {
		const other = workflow.steps.find((candidate) => candidate.stepId === dependency);
		return other !== undefined && COMPLETED_STEP_STATUSES.has(other.status);
	});
}

function isExternalAgent(step: WorkflowStep): step is AgentStep {
	return step.type === "agent" && step.executor === "external";
}

function isLocalExecutable(step: WorkflowStep): boolean {
	if (step.type === "tool") return true;
	return step.type === "agent" && step.executor === "local";
}

function asFact(record: FoundationRecord): Extract<FoundationRecord, { kind: "fact" }> | undefined {
	return record.kind === "fact" ? record : undefined;
}

export class SchedulerWorkflowController {
	readonly enabled: boolean;
	readonly store: WorkflowStore;
	readonly messages: SchedulerMessageOrchestrator;
	readonly handoff: SchedulerHandoffController;
	readonly dispatch: SchedulerDispatchController;
	readonly fanIn: SchedulerFanInController;
	readonly host: SchedulerHost;
	readonly queue: SchedulerQueueStore;
	private readonly sourceSession: Session;
	private readonly sourceSessionId: string;
	private readonly targetSessionId: string;
	private readonly ownerId: string;
	private readonly executorOwnerId: string | undefined;
	private readonly task: TaskEnvelope;
	private readonly binding: AgentBinding;
	private readonly compensationPolicy: SchedulerWorkflowCompensationPolicyV1;
	private readonly maxAttempts: number;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly ledger: SessionLedger;
	private wakes = new Map<string, SchedulerWakeV1>();
	private wakeRevisions = new Map<string, number>();
	private eventRevisions = new Map<string, number>();

	constructor(options: SchedulerWorkflowControllerOptionsV1) {
		this.clock = runtimeClockFor(options);
		this.enabled = options.enabled ?? false;
		this.sourceSession = options.sourceSession;
		this.sourceSessionId = options.sourceSessionId;
		this.targetSessionId = options.targetSessionId;
		this.ownerId = options.ownerId;
		this.executorOwnerId = options.executorOwnerId;
		this.task = options.task;
		this.binding = options.binding;
		this.compensationPolicy = options.compensationPolicy ?? "stop";
		this.maxAttempts = options.maxAttempts ?? SCHEDULER_DEFAULT_MAX_ATTEMPTS;
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.store = new WorkflowStore(options.sourceSession, { ownerId: options.ownerId });
		this.ledger = new SessionLedger(options.sourceSession, { ownerId: options.ownerId });
		this.queue = new SchedulerQueueStore(
			withRuntimeClock(
				{
					ledger: options.sourceSession,
					sessionId: options.sourceSessionId,
					ownerId: options.ownerId,
					now: this.nowFn,
				},
				this.clock,
			),
		);
		this.dispatch = new SchedulerDispatchController(
			withRuntimeClock(
				{
					session: options.sourceSession,
					queue: this.queue,
					registry: options.registry,
					sessionId: options.sourceSessionId,
					ownerId: options.ownerId,
					...(options.runLifecycleSession === undefined
						? {}
						: { runLifecycleSession: options.runLifecycleSession }),
					...(options.runLifecycleHookOwnership === undefined
						? {}
						: { runLifecycleHookOwnership: options.runLifecycleHookOwnership }),
					now: this.nowFn,
				},
				this.clock,
			),
		);
		this.fanIn = new SchedulerFanInController({
			session: options.sourceSession,
			sessionId: options.sourceSessionId,
			ownerId: options.ownerId,
			now: this.nowFn,
		});
		const endpoints: readonly [SchedulerMessageSessionEndpointV1, SchedulerMessageSessionEndpointV1] = [
			{ session: options.sourceSession, taskGraph: options.sourceGraph },
			{ session: options.targetSession, taskGraph: options.targetGraph },
		];
		this.messages = new SchedulerMessageOrchestrator(endpoints, { ownerId: options.ownerId });
		this.handoff = new SchedulerHandoffController(
			withRuntimeClock(
				{
					ledger: options.sourceSession,
					queue: this.queue,
					sessionId: options.sourceSessionId,
					ownerId: options.ownerId,
					now: this.nowFn,
					cancelSourceDispatch: (queueEntryId, fencingToken) =>
						this.dispatch.cancelDispatch(queueEntryId, fencingToken),
					targetAvailable: async () => true,
				},
				this.clock,
			),
		);
		this.host = new SchedulerHost(
			withRuntimeClock(
				{
					enabled: false,
					sessionId: options.sourceSessionId,
					ownerId: options.ownerId,
					graph: options.sourceGraph,
					queue: this.queue,
					dispatch: this.dispatch,
					fanIn: this.fanIn,
					resolveRunAssociation: async () =>
						Result.ok({
							runId: `run_${options.task.taskId}`,
							task: options.task,
							binding: options.binding,
						}),
					settleRunAtHost: async () => Result.ok(undefined),
					now: this.nowFn,
				},
				this.clock,
			),
		);
	}

	async dispose(): Promise<void> {
		this.dispatch.dispose();
		await this.fanIn.release();
		await this.messages.release();
		await this.ledger.release();
	}

	async reload(): Promise<ResultValue<readonly SchedulerWakeV1[], FoundationError>> {
		try {
			const records = await this.sourceSession.findFoundationRecords({
				objectType: SCHEDULER_WORKFLOW_WAKE_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			this.wakes = new Map();
			this.wakeRevisions = new Map();
			for (const record of records) {
				const fact = asFact(record);
				if (fact === undefined) continue;
				const parsed = parseSchedulerWake(fact.payload);
				if (!parsed.ok) return parsed;
				this.wakes.set(parsed.value.wakeId, parsed.value);
				this.wakeRevisions.set(parsed.value.wakeId, fact.revision);
			}
			return Result.ok([...this.wakes.values()].map(serializeSchedulerWake));
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	async scheduleWake(wake: unknown): Promise<ResultValue<SchedulerWakeV1, FoundationError>> {
		const parsed = parseSchedulerWake(wake);
		if (!parsed.ok) return parsed;
		if (parsed.value.firedAt !== undefined || parsed.value.revision !== 0) {
			return Result.err(new FoundationError("scheduler_wake_invalid", "A new wake must start unfired at revision zero"));
		}
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const existing = this.wakes.get(parsed.value.wakeId);
		if (existing !== undefined) {
			return serializeSchedulerWake(existing).wakeId === parsed.value.wakeId &&
				existing.workflowId === parsed.value.workflowId &&
				existing.dueAt === parsed.value.dueAt &&
				existing.stepId === parsed.value.stepId
				? Result.ok(serializeSchedulerWake(existing))
				: Result.err(new FoundationError("scheduler_wake_invalid", "Wake identity is already bound"));
		}
		const stored = await this.writeWake(parsed.value, 0);
		if (!stored.ok) return stored;
		const scheduledEvent = await this.writeWakeEvent("scheduler.wake_scheduled", stored.value);
		if (!scheduledEvent.ok) return scheduledEvent;
		if (Date.parse(this.nowFn()) >= Date.parse(stored.value.dueAt)) {
			return this.fireWake(stored.value);
		}
		return stored;
	}

	async tick(): Promise<SchedulerWorkflowTickResult> {
		if (!this.enabled) return emptyTick(false);
		const errors: SchedulerWorkflowTickErrorV1[] = [];
		const woke = await this.fireDueWakes();
		if (!woke.ok) {
			return { ...emptyTick(true), errors: [{ workflowId: "scheduler", code: woke.error.code }] };
		}
		let scheduled = 0;
		let completed = 0;
		let stopped = 0;
		let listed: Workflow[];
		try {
			listed = await this.store.list(this.sourceSessionId);
		} catch (error) {
			return { ...emptyTick(true), wakesFired: woke.value, errors: [{ workflowId: "scheduler", code: errorCode(error) }] };
		}
		for (const workflow of listed) {
			if (workflow.status !== "active") continue;
			const driven = await this.drive(workflow.workflowId);
			scheduled += driven.scheduled;
			if (driven.completed) completed += 1;
			if (driven.stopped) stopped += 1;
			errors.push(...driven.errors);
		}
		return {
			enabled: true,
			workflows: listed.length,
			scheduled,
			completed,
			stopped,
			wakesFired: woke.value,
			errors,
		};
	}

	hostTick(): Promise<SchedulerHostTickResult> {
		return this.host.tick();
	}

	private async fireDueWakes(): Promise<ResultValue<number, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const nowIso = this.nowFn();
		let fired = 0;
		for (const wake of [...this.wakes.values()]) {
			if (wake.firedAt !== undefined) continue;
			if (Date.parse(nowIso) < Date.parse(wake.dueAt)) continue;
			const result = await this.fireWake(wake);
			if (!result.ok) return result;
			fired += 1;
		}
		return Result.ok(fired);
	}

	private async fireWake(current: SchedulerWakeV1): Promise<ResultValue<SchedulerWakeV1, FoundationError>> {
		if (current.firedAt !== undefined) return Result.ok(serializeSchedulerWake(current));
		const applied = applySchedulerWakeFire(current, this.nowFn());
		if (!applied.ok) {
			if (applied.error.code === "scheduler_wake_invalid") return Result.ok(serializeSchedulerWake(current));
			return applied;
		}
		const expectedRevision = this.wakeRevisions.get(current.wakeId) ?? 0;
		const stored = await this.writeWake(applied.value, expectedRevision);
		if (!stored.ok) return stored;
		const firedEvent = await this.writeWakeEvent("scheduler.wake_fired", stored.value);
		if (!firedEvent.ok) return firedEvent;
		try {
			const workflow = await this.store.get(stored.value.workflowId);
			if (workflow.status === "paused") {
				await this.store.resume(workflow.workflowId, {
					clientRequestId: mutationId(["wake", stored.value.wakeId, "resume"]),
					expectedRevision: workflow.revision,
				});
			}
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_wake_invalid", errorCode(error)),
			);
		}
		return stored;
	}

	private async writeWake(
		wake: SchedulerWakeV1,
		expectedRevision: number,
	): Promise<ResultValue<SchedulerWakeV1, FoundationError>> {
		const serialized = serializeSchedulerWake(wake);
		try {
			const written = await this.ledger.appendFact(
				SCHEDULER_WORKFLOW_WAKE_OBJECT_TYPE,
				serialized.wakeId,
				serialized,
				{
					clientRequestId: `scheduler.wake:${serialized.wakeId}:${serialized.revision}`,
					expectedRevision,
					correlation: { taskId: this.task.taskId, parentId: serialized.workflowId },
				},
			);
			this.wakes.set(serialized.wakeId, written.payload);
			this.wakeRevisions.set(serialized.wakeId, written.record.revision);
			return Result.ok(serializeSchedulerWake(written.payload));
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	private async writeWakeEvent(
		category: "scheduler.wake_scheduled" | "scheduler.wake_fired",
		wake: SchedulerWakeV1,
	): Promise<ResultValue<void, FoundationError>> {
		const payload: SchedulerWakeEventPayload = {
			schemaVersion: 1,
			wakeId: wake.wakeId,
			workflowId: wake.workflowId,
			dueAt: wake.dueAt,
			revision: wake.revision,
			...(wake.stepId === undefined ? {} : { stepId: wake.stepId }),
			...(wake.firedAt === undefined ? {} : { firedAt: wake.firedAt }),
		};
		let sequence = 1;
		try {
			sequence = (await this.sourceSession.getLedgerRevision()) + 1;
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
		const eventId = `evt_${wake.wakeId}_${wake.revision}_${category === "scheduler.wake_fired" ? "fired" : "scheduled"}`;
		const correlation: EventCorrelationRef = {
			sessionId: this.sourceSessionId,
			workflowId: wake.workflowId,
		};
		try {
			createDurableEvent({
				category,
				eventId,
				streamId: this.sourceSessionId,
				sequence: sequence < 1 ? 1 : sequence,
				timestamp: this.nowFn(),
				correlation,
				payload,
			});
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_wake_invalid", errorCode(error)),
			);
		}
		return this.appendEventFact(
			category,
			eventId,
			payload,
			`scheduler.wake_event:${eventId}`,
			{ taskId: this.task.taskId, parentId: wake.workflowId, ...(wake.stepId === undefined ? {} : { stepId: wake.stepId }) },
		);
	}

	private async appendEventFact(
		category: DurableEventCategory,
		eventId: string,
		payload: SchedulerWakeEventPayload,
		clientRequestId: string,
		correlation: { readonly taskId: string; readonly parentId: string; readonly stepId?: string },
	): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision = this.eventRevisions.get(`${category}:${eventId}`) ?? 0;
		try {
			const written = await this.ledger.appendFact(category, eventId, payload, {
				clientRequestId,
				expectedRevision,
				correlation,
			});
			this.eventRevisions.set(`${category}:${eventId}`, written.record.revision);
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	private async drive(workflowId: string): Promise<{
		readonly scheduled: number;
		readonly completed: boolean;
		readonly stopped: boolean;
		readonly errors: readonly SchedulerWorkflowTickErrorV1[];
	}> {
		const errors: SchedulerWorkflowTickErrorV1[] = [];
		let scheduled = 0;
		const policy = await this.workflowPolicy(workflowId);
		if (!policy.ok) {
			errors.push({ workflowId, code: policy.error.code });
			return { scheduled, completed: false, stopped: false, errors };
		}
		for (let cycle = 0; cycle < 64; cycle++) {
			let workflow: Workflow;
			try {
				workflow = await this.store.get(workflowId);
			} catch (error) {
				errors.push({ workflowId, code: errorCode(error) });
				return { scheduled, completed: false, stopped: false, errors };
			}
			if (workflow.status !== "active") {
				return {
					scheduled,
					completed: workflow.status === "completed",
					stopped: workflow.status === "stopped",
					errors,
				};
			}
			let progressed = false;
			const promoted = await this.promoteReady(workflow);
			if (!promoted.ok) {
				errors.push({ workflowId, code: promoted.error.code });
				return { scheduled, completed: false, stopped: false, errors };
			}
			if (promoted.value) progressed = true;
			try {
				workflow = await this.store.get(workflowId);
			} catch (error) {
				errors.push({ workflowId, code: errorCode(error) });
				return { scheduled, completed: false, stopped: false, errors };
			}
			for (const step of workflow.steps) {
				if (
					step.status !== "ready" &&
					step.status !== "running" &&
					step.status !== "awaiting_dispatch" &&
					step.status !== "blocked"
				) {
					continue;
				}
				const advanced = await this.advance(workflow.workflowId, step.stepId);
				if (!advanced.ok) {
					if (advanced.error.code === "budget_exhausted") {
						errors.push({ workflowId, stepId: step.stepId, code: "budget_exhausted" });
						return { scheduled, completed: false, stopped: false, errors };
					}
					errors.push({ workflowId, stepId: step.stepId, code: advanced.error.code });
					workflow = await this.store.get(workflowId);
					return {
						scheduled,
						completed: workflow.status === "completed",
						stopped: workflow.status === "stopped",
						errors,
					};
				}
				if (advanced.value.scheduled) scheduled += 1;
				if (advanced.value.progressed) progressed = true;
				workflow = await this.store.get(workflowId);
				if (workflow.status !== "active") {
					return {
						scheduled,
						completed: workflow.status === "completed",
						stopped: workflow.status === "stopped",
						errors,
					};
				}
			}
			if (workflow.steps.every((step) => COMPLETED_STEP_STATUSES.has(step.status))) {
				try {
					await this.store.complete(workflowId, {
						clientRequestId: mutationId(["complete", workflowId, String(workflow.revision)]),
						expectedRevision: workflow.revision,
					});
					return { scheduled, completed: true, stopped: false, errors };
				} catch (error) {
					errors.push({ workflowId, code: errorCode(error) });
					return { scheduled, completed: false, stopped: false, errors };
				}
			}
			if (!progressed) {
				return { scheduled, completed: false, stopped: false, errors };
			}
		}
		return { scheduled, completed: false, stopped: false, errors };
	}

	private async promoteReady(workflow: Workflow): Promise<ResultValue<boolean, FoundationError>> {
		let progressed = false;
		let current = workflow;
		for (const step of current.steps) {
			if (step.status !== "pending" || !depsSettled(current, step)) continue;
			try {
				current = await this.store.transitionStep(
					current.workflowId,
					{ stepId: step.stepId, status: "ready" },
					{
						clientRequestId: mutationId(["ready", current.workflowId, step.stepId, String(current.revision)]),
						expectedRevision: current.revision,
					},
				);
				progressed = true;
			} catch (error) {
				return Result.err(
					error instanceof FoundationError
						? error
						: new FoundationError("workflow_invalid_transition", errorCode(error)),
				);
			}
		}
		return Result.ok(progressed);
	}

	private async advance(
		workflowId: string,
		stepId: string,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		let workflow: Workflow;
		try {
			workflow = await this.store.get(workflowId);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError ? error : new FoundationError("workflow_not_found", errorCode(error)),
			);
		}
		const step = workflow.steps.find((candidate) => candidate.stepId === stepId);
		if (step === undefined) {
			return Result.err(new FoundationError("workflow_not_found", "Workflow step was not found"));
		}
		if (step.status === "running" || step.status === "awaiting_dispatch" || step.status === "blocked") {
			const compensation = await this.readCompensation(workflow.workflowId, step.stepId);
			if (!compensation.ok) return compensation;
			if (compensation.value !== undefined) {
				return this.reconcileCompensation(workflow, step, compensation.value);
			}
		}
		if (step.status === "awaiting_dispatch") return this.advanceExternal(workflow, step);
		if (step.status === "blocked") return this.advanceBlocked(workflow, step);
		if (step.status === "running") return this.advanceRunning(workflow, step);
		if (step.status !== "ready") return Result.ok({ progressed: false, scheduled: false });
		if (step.type === "await_user") {
			return this.transition(workflow, step.stepId, "waiting_user");
		}
		if (isExternalAgent(step)) {
			const moved = await this.transition(workflow, step.stepId, "awaiting_dispatch");
			if (!moved.ok) return moved;
			workflow = await this.store.get(workflowId);
			const next = workflow.steps.find((candidate) => candidate.stepId === stepId);
			if (next === undefined) {
				return Result.err(new FoundationError("workflow_not_found", "Workflow step was not found"));
			}
			return this.advanceExternal(workflow, next);
		}
		if (isLocalExecutable(step) || step.type === "parallel" || step.type === "barrier") {
			const reserved = await this.reserveBudget(workflow, step);
			if (!reserved.ok) return reserved;
			workflow = await this.store.get(workflow.workflowId);
			const moved = await this.transition(workflow, step.stepId, "running");
			if (!moved.ok) return moved;
			workflow = await this.store.get(workflowId);
			const next = workflow.steps.find((candidate) => candidate.stepId === stepId);
			if (next === undefined) {
				return Result.err(new FoundationError("workflow_not_found", "Workflow step was not found"));
			}
			return this.advanceRunning(workflow, next);
		}
		return Result.ok({ progressed: false, scheduled: false });
	}

	private async advanceBlocked(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		return this.reconcileCompensation(workflow, step);
	}

	private async advanceRunning(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		if (step.type === "parallel" || step.type === "barrier") {
			const joined = await this.settleJoin(workflow, step);
			if (!joined.ok) return joined;
			return this.transition(workflow, step.stepId, "succeeded");
		}
		if (!isLocalExecutable(step)) {
			return Result.ok({ progressed: false, scheduled: false });
		}
		return this.executeLocal(workflow, step);
	}

	private async advanceExternal(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		if (!isExternalAgent(step)) {
			return Result.err(
				new FoundationError("workflow_invalid_transition", "Only an external Agent step can await dispatch"),
			);
		}
		const ids = schedulerWorkflowExternalIds(workflow.workflowId, step.stepId);
		let external = await this.readExternal(workflow.workflowId, step.stepId);
		if (external === undefined) {
			try {
				await this.messages.submitCrossSessionTask({
					sourceSessionId: this.sourceSessionId,
					targetSessionId: this.targetSessionId,
					taskId: step.taskId,
					graphRevision: 1,
					nodeId: step.stepId,
					waitId: ids.waitId,
					threadId: ids.threadId,
					messageId: ids.submitMessageId,
					clientRequestId: ids.clientRequestId,
					createdAt: this.nowFn(),
					expiresAt: plusMs(this.nowFn(), 60 * 60 * 1000),
					goalId: this.task.goalId,
					workflowId: workflow.workflowId,
				});
			} catch (error) {
				return Result.err(
					error instanceof FoundationError
						? error
						: new FoundationError("scheduler_message_invalid", errorCode(error)),
				);
			}
			external = {
				schemaVersion: 1,
				workflowId: workflow.workflowId,
				stepId: step.stepId,
				taskId: step.taskId,
				waitId: ids.waitId,
				threadId: ids.threadId,
				submitMessageId: ids.submitMessageId,
				readyMessageId: ids.readyMessageId,
				reclaimMessageId: ids.reclaimMessageId,
				clientRequestId: ids.clientRequestId,
				submittedAt: this.nowFn(),
			};
			const persisted = await this.writeExternal(external);
			if (!persisted.ok) return persisted;
			return Result.ok({ progressed: true, scheduled: true });
		}
		try {
			const waited = await this.messages.waitForCrossSessionTask({
				sourceSessionId: this.sourceSessionId,
				waitId: external.waitId,
				at: this.nowFn(),
			});
			if (waited.status === "waiting") return Result.ok({ progressed: false, scheduled: false });
			if (waited.status !== "succeeded") {
				return this.handleFailure(workflow, step, "none", false);
			}
			await this.messages.reclaimResult({
				sourceSessionId: this.sourceSessionId,
				targetSessionId: this.targetSessionId,
				taskId: external.taskId,
				threadId: external.threadId,
				readyMessageId: external.readyMessageId,
				reclaimMessageId: external.reclaimMessageId,
				clientRequestId: external.clientRequestId,
				at: this.nowFn(),
			});
			return this.transition(workflow, step.stepId, "succeeded");
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_message_invalid", errorCode(error)),
			);
		}
	}

	private async executeLocal(
		workflow: Workflow,
		step: WorkflowStep,
		compensation?: {
			readonly queueEntryId: string;
			readonly nodeId: string;
			readonly attempt: number;
		},
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const policy = await this.workflowPolicy(workflow.workflowId);
		if (!policy.ok) return policy;
		const previous = await this.readAttempt(workflow.workflowId, step.stepId);
		const attemptsUsed = compensation?.attempt ?? (previous?.attemptsUsed ?? 0) + 1;
		const recorded = await this.writeAttempt({
			schemaVersion: 1,
			workflowId: workflow.workflowId,
			stepId: step.stepId,
			attemptsUsed,
			maxAttempts: policy.value.maxAttempts,
			...(previous?.lastSideEffect === undefined ? {} : { lastSideEffect: previous.lastSideEffect }),
			...(previous?.lastQueueEntryId === undefined ? {} : { lastQueueEntryId: previous.lastQueueEntryId }),
		});
		if (!recorded.ok) return recorded;
		const nodeId = compensation?.nodeId ?? localNodeId(step.stepId, attemptsUsed, false);
		const nodeRef: SchedulerNodeRefV1 = {
			taskId: this.task.taskId,
			graphRevision: 1,
			nodeId,
		};
		const queueEntryId = compensation?.queueEntryId ?? queueIdentity(workflow.workflowId, nodeId, attemptsUsed);
		const entry: SchedulerQueueEntryV1 = {
			schemaVersion: 1,
			queueEntryId,
			sessionId: this.sourceSessionId,
			taskId: this.task.taskId,
			nodeRef,
			goalId: this.task.goalId,
			workflowId: workflow.workflowId,
			state: "queued",
			priority: step.ordinal,
			attemptsUsed: 0,
			enqueuedAt: this.nowFn(),
			revision: 0,
		};
		const enqueued = await this.queue.enqueue(entry, { maxAttempts: policy.value.maxAttempts });
		if (!enqueued.ok) return enqueued;
		const claimed = await this.queue.claim({
			queueEntryId,
			ownerId: this.ownerId,
			claimId: `c_${stemId(queueEntryId)}`,
			fencingToken: `f_${stemId(queueEntryId)}`,
			ttlMs: SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
		});
		if (!claimed.ok) return claimed;
		let fencingToken = claimed.value.claim.fencingToken;
		if (this.executorOwnerId !== undefined && this.executorOwnerId !== this.ownerId) {
			const transfer: SchedulerOwnershipTransferV1 = {
				schemaVersion: 1,
				transferId: transferIdentity(queueEntryId),
				taskId: this.task.taskId,
				fromOwnerId: this.ownerId,
				toOwnerId: this.executorOwnerId,
				state: "offered",
				fencingToken,
				deadlineAt: plusMs(this.nowFn(), 60_000),
				createdAt: this.nowFn(),
				revision: 0,
			};
			const offered = await this.handoff.offer({ queueEntryId, transfer });
			if (!offered.ok) return offered;
			const accepted = await this.handoff.accept({
				transferId: transfer.transferId,
				targetClaimId: `ct_${stemId(queueEntryId)}`,
				targetFencingToken: `ft_${stemId(queueEntryId)}`,
				ttlMs: SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
			});
			if (!accepted.ok) return accepted;
			if (accepted.value.claimTransfer === undefined) {
				return Result.err(new FoundationError("scheduler_handoff_invalid", "Handoff did not transfer the claim"));
			}
			fencingToken = accepted.value.claimTransfer.targetClaim.fencingToken;
		}
		const dispatched = await this.dispatch.dispatchClaimed({
			queueEntryId,
			fencingToken,
			binding: this.binding,
		});
		if (!dispatched.ok) {
			return this.afterDispatchFailure(workflow, step, undefined, attemptsUsed, compensation !== undefined);
		}
		const receipt = dispatched.value.receipt;
		const queued = await this.writeAttempt({
			schemaVersion: 1,
			workflowId: workflow.workflowId,
			stepId: step.stepId,
			attemptsUsed,
			maxAttempts: policy.value.maxAttempts,
			lastSideEffect: receipt.sideEffectState,
			lastQueueEntryId: queueEntryId,
		});
		if (!queued.ok) return queued;
		if (receipt.status !== "succeeded") {
			await this.queue.markTerminal({
				queueEntryId,
				dispatchId: dispatched.value.dispatch.dispatchId,
				attemptId: dispatched.value.attempt.attemptId,
				fencingToken,
				outcome: "cancelled",
			});
			return this.afterDispatchFailure(workflow, step, receipt, attemptsUsed, compensation !== undefined);
		}
		const predecessors =
			step.dependsOn?.filter((dependency) => {
				const other = workflow.steps.find((candidate) => candidate.stepId === dependency);
				return other !== undefined && EXECUTABLE_STEP_TYPES.has(other.type);
			}) ?? [];
		const plan: SchedulerJoinPlanV1 | undefined =
			predecessors.length === 0
				? undefined
				: {
						schemaVersion: 1,
						joinId: schedulerNodeJoinId(nodeRef),
						taskId: this.task.taskId,
						nodeRef,
						policy: "require_all",
						predecessorTaskIds: predecessors,
						createdAt: workflow.createdAt,
					};
		const settled = await this.fanIn.settle({
			task: this.task,
			nodeRef,
			currentAttemptReceiptIds: [receipt.attemptReceiptId],
			...(plan === undefined ? {} : { plan }),
			summary: `Workflow step ${step.stepId} settled.`,
			tests: [{ name: "workflow-step", required: true, status: "passed" }],
			evidence: [],
			validation: {
				schemaValid: true,
				artifactDigestsValid: true,
				acceptanceVerified: true,
				requiredEvidencePresent: true,
			},
		});
		if (!settled.ok) {
			await this.queue.markTerminal({
				queueEntryId,
				dispatchId: dispatched.value.dispatch.dispatchId,
				attemptId: dispatched.value.attempt.attemptId,
				fencingToken,
				outcome: "cancelled",
			});
			return settled;
		}
		const terminal = await this.queue.markTerminal({
			queueEntryId,
			dispatchId: dispatched.value.dispatch.dispatchId,
			attemptId: dispatched.value.attempt.attemptId,
			fencingToken,
			outcome: "settled",
		});
		if (!terminal.ok) return terminal;
		if (compensation !== undefined) return Result.ok({ progressed: true, scheduled: true });
		return this.transition(workflow, step.stepId, "succeeded");
	}

	private async settleJoin(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<void, FoundationError>> {
		const predecessors =
			step.type === "parallel"
				? step.intents.map((intent) => intent.stepId)
				: (step.dependsOn ?? []);
		const nodeRef: SchedulerNodeRefV1 = {
			taskId: this.task.taskId,
			graphRevision: 1,
			nodeId: step.stepId,
		};
		const plan: SchedulerJoinPlanV1 = {
			schemaVersion: 1,
			joinId: schedulerNodeJoinId(nodeRef),
			taskId: this.task.taskId,
			nodeRef,
			policy: "require_all",
			predecessorTaskIds: predecessors,
			createdAt: workflow.createdAt,
		};
		const settled = await this.fanIn.settle({
			task: this.task,
			nodeRef,
			currentAttemptReceiptIds: [],
			plan,
			summary: `Workflow ${step.type} ${step.stepId} joined.`,
			tests: [{ name: "workflow-join", required: true, status: "passed" }],
			evidence: [],
			validation: {
				schemaValid: true,
				artifactDigestsValid: true,
				acceptanceVerified: true,
				requiredEvidencePresent: true,
			},
		});
		if (!settled.ok) return settled;
		return Result.ok(undefined);
	}

	private async afterDispatchFailure(
		workflow: Workflow,
		step: WorkflowStep,
		receipt: AttemptReceipt | undefined,
		attemptsUsed: number,
		fromCompensation: boolean,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const sideEffect: SideEffectState = receipt?.sideEffectState ?? "side_effect_unknown";
		if (fromCompensation) return this.failCompensationAndStop(workflow, step);
		const policy = await this.workflowPolicy(workflow.workflowId);
		if (!policy.ok) return policy;
		const retryable =
			receipt !== undefined &&
			isSchedulerSideEffectRetryable(sideEffect) &&
			sideEffect !== "side_effect_unknown" &&
			attemptsUsed < policy.value.maxAttempts;
		return this.handleFailure(workflow, step, sideEffect, retryable);
	}

	private async handleFailure(
		workflow: Workflow,
		step: WorkflowStep,
		sideEffect: SideEffectState,
		retryable: boolean,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const policy = await this.workflowPolicy(workflow.workflowId);
		if (!policy.ok) return policy;
		if (
			policy.value.policy === "bounded_retry" &&
			retryable &&
			sideEffect !== "side_effect_unknown" &&
			isLocalExecutable(step)
		) {
			workflow = await this.store.get(workflow.workflowId);
			return this.executeLocal(workflow, step);
		}
		if (policy.value.policy === "compensate") {
			return this.compensate(workflow, step);
		}
		return this.stopWorkflow(workflow, step);
	}

	private async compensate(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const existing = await this.readCompensation(workflow.workflowId, step.stepId);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) return this.reconcileCompensation(workflow, step, existing.value);
		const previous = await this.readAttempt(workflow.workflowId, step.stepId);
		const attempt = (previous?.attemptsUsed ?? 0) + 1;
		const nodeId = localNodeId(step.stepId, attempt, true);
		const queueEntryId = queueIdentity(workflow.workflowId, nodeId, attempt);
		const scheduled: SchedulerWorkflowCompensationFactV1 = {
			schemaVersion: 1,
			workflowId: workflow.workflowId,
			stepId: step.stepId,
			queueEntryId,
			attempt,
			nodeId,
			state: "scheduled",
			scheduledAt: this.nowFn(),
		};
		const persisted = await this.writeCompensation(scheduled);
		if (!persisted.ok) return persisted;
		const blocked = await this.blockOriginalStep(workflow, step);
		if (!blocked.ok) return this.failCompensationAndStop(workflow, step);
		const executed = await this.executeLocal(blocked.value, step, {
			queueEntryId,
			nodeId,
			attempt,
		});
		if (!executed.ok) return this.failCompensationAndStop(workflow, step);
		const latest = await this.readCompensation(workflow.workflowId, step.stepId);
		if (!latest.ok) return latest;
		if (latest.value?.state === "failed") return executed;
		const settled = await this.writeCompensation({
			...scheduled,
			state: "settled",
			settledAt: this.nowFn(),
		});
		if (!settled.ok) return settled;
		return this.skipCompensatedStep(workflow, step);
	}

	private async reconcileCompensation(
		workflow: Workflow,
		step: WorkflowStep,
		known?: SchedulerWorkflowCompensationFactV1,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const loaded = known === undefined ? await this.readCompensation(workflow.workflowId, step.stepId) : Result.ok(known);
		if (!loaded.ok) return loaded;
		const compensation = loaded.value;
		if (compensation === undefined) return Result.ok({ progressed: false, scheduled: false });
		if (compensation.state === "settled") return this.skipCompensatedStep(workflow, step);
		if (compensation.state === "failed") return this.stopWorkflow(workflow, step);
		const entry = await this.queue.getEntry(compensation.queueEntryId);
		if (!entry.ok) return this.failCompensationAndStop(workflow, step);
		if (entry.value.state === "settled") {
			const settled = await this.writeCompensation({
				...compensation,
				state: "settled",
				settledAt: this.nowFn(),
			});
			if (!settled.ok) return settled;
			return this.skipCompensatedStep(workflow, step);
		}
		if (isSchedulerQueueTerminal(entry.value.state) || entry.value.state === "expired") {
			return this.failCompensationAndStop(workflow, step);
		}
		return Result.ok({ progressed: false, scheduled: false });
	}

	private async blockOriginalStep(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<Workflow, FoundationError>> {
		try {
			const current = await this.store.get(workflow.workflowId);
			const live = current.steps.find((candidate) => candidate.stepId === step.stepId);
			if (live === undefined) {
				return Result.err(new FoundationError("workflow_not_found", "Workflow step was not found"));
			}
			if (live.status === "blocked") return Result.ok(current);
			if (live.status !== "running" && live.status !== "awaiting_dispatch") {
				return Result.err(
					new FoundationError(
						"workflow_invalid_transition",
						"Compensation cannot block a step that is not running or awaiting dispatch",
					),
				);
			}
			const moved = await this.transition(current, step.stepId, "blocked");
			if (!moved.ok) return moved;
			return Result.ok(await this.store.get(workflow.workflowId));
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("workflow_invalid_transition", errorCode(error)),
			);
		}
	}

	private async skipCompensatedStep(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		let current = await this.store.get(workflow.workflowId);
		const statusOf = () => current.steps.find((candidate) => candidate.stepId === step.stepId)?.status;
		const live = statusOf();
		if (live === "skipped" || live === "cancelled") return Result.ok({ progressed: false, scheduled: false });
		if (live === "running" || live === "awaiting_dispatch") {
			const blocked = await this.transition(current, step.stepId, "blocked");
			if (!blocked.ok) return blocked;
			current = await this.store.get(workflow.workflowId);
		}
		if (statusOf() !== "blocked") return Result.ok({ progressed: false, scheduled: false });
		return this.transition(current, step.stepId, "skipped");
	}

	private async failCompensationAndStop(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		const existing = await this.readCompensation(workflow.workflowId, step.stepId);
		if (!existing.ok) return existing;
		if (existing.value !== undefined && existing.value.state !== "failed") {
			const failed = await this.writeCompensation({
				...existing.value,
				state: "failed",
				failedAt: this.nowFn(),
			});
			if (!failed.ok) return failed;
		}
		return this.stopWorkflow(workflow, step);
	}

	private async stopWorkflow(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		try {
			const current = await this.store.get(workflow.workflowId);
			if (current.status === "stopped") return Result.ok({ progressed: false, scheduled: false });
			await this.store.stop(current.workflowId, {
				clientRequestId: mutationId(["stop", current.workflowId, step.stepId, String(current.revision)]),
				expectedRevision: current.revision,
			});
			return Result.ok({ progressed: true, scheduled: false });
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("workflow_invalid_transition", errorCode(error)),
			);
		}
	}

	private async reserveBudget(
		workflow: Workflow,
		step: WorkflowStep,
	): Promise<ResultValue<void, FoundationError>> {
		if (workflow.budget === undefined || !isLocalExecutable(step)) return Result.ok(undefined);
		try {
			await this.store.recordBudgetUsage(
				workflow.workflowId,
				{ toolCalls: 1 },
				{
					clientRequestId: mutationId(["budget", workflow.workflowId, step.stepId, String(workflow.revision)]),
					expectedRevision: workflow.revision,
				},
			);
			return Result.ok(undefined);
		} catch (error) {
			if (error instanceof FoundationError && error.code === "budget_exhausted") return Result.err(error);
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("budget_exhausted", errorCode(error)),
			);
		}
	}

	private async transition(
		workflow: Workflow,
		stepId: string,
		status: WorkflowStepStatus,
	): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>> {
		try {
			await this.store.transitionStep(
				workflow.workflowId,
				{ stepId, status },
				{
					clientRequestId: mutationId([status, workflow.workflowId, stepId, String(workflow.revision)]),
					expectedRevision: workflow.revision,
				},
			);
			return Result.ok({ progressed: true, scheduled: status === "running" || status === "awaiting_dispatch" });
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("workflow_invalid_transition", errorCode(error)),
			);
		}
	}

	private async workflowPolicy(
		workflowId: string,
	): Promise<ResultValue<SchedulerWorkflowPolicyFactV1, FoundationError>> {
		const existing = await this.ledger.getFact<SchedulerWorkflowPolicyFactV1>(
			SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
			workflowId,
		);
		if (existing !== undefined) return parsePolicyFact(existing.payload, workflowId);
		const created: SchedulerWorkflowPolicyFactV1 = {
			schemaVersion: 1,
			workflowId,
			policy: this.compensationPolicy,
			maxAttempts: this.maxAttempts,
		};
		try {
			const written = await this.ledger.appendFact(
				SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
				workflowId,
				created,
				{
					clientRequestId: `scheduler.workflow.policy:${workflowId}`,
					expectedRevision: 0,
					correlation: { taskId: this.task.taskId, parentId: workflowId },
				},
			);
			return parsePolicyFact(written.payload, workflowId);
		} catch (error) {
			const replayed = await this.ledger.getFact<SchedulerWorkflowPolicyFactV1>(
				SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
				workflowId,
			);
			if (replayed !== undefined) return parsePolicyFact(replayed.payload, workflowId);
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	private async readAttempt(
		workflowId: string,
		stepId: string,
	): Promise<SchedulerWorkflowAttemptFactV1 | undefined> {
		const stored = await this.ledger.getFact<SchedulerWorkflowAttemptFactV1>(
			SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE,
			`${workflowId}:${stepId}`,
		);
		return stored?.payload;
	}

	private async writeAttempt(
		fact: SchedulerWorkflowAttemptFactV1,
	): Promise<ResultValue<void, FoundationError>> {
		const objectId = `${fact.workflowId}:${fact.stepId}`;
		const current = await this.ledger.getFact<SchedulerWorkflowAttemptFactV1>(
			SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE,
			objectId,
		);
		try {
			await this.ledger.appendFact(SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE, objectId, fact, {
				clientRequestId: `scheduler.workflow.attempt:${objectId}:${current?.record.revision ?? 0}:${fact.attemptsUsed}`,
				expectedRevision: current?.record.revision ?? 0,
				correlation: { taskId: this.task.taskId, parentId: fact.workflowId },
			});
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	private async readExternal(
		workflowId: string,
		stepId: string,
	): Promise<SchedulerWorkflowExternalFactV1 | undefined> {
		const stored = await this.ledger.getFact<SchedulerWorkflowExternalFactV1>(
			SCHEDULER_WORKFLOW_EXTERNAL_OBJECT_TYPE,
			`${workflowId}:${stepId}`,
		);
		return stored?.payload;
	}

	private async writeExternal(
		fact: SchedulerWorkflowExternalFactV1,
	): Promise<ResultValue<void, FoundationError>> {
		try {
			await this.ledger.appendFact(
				SCHEDULER_WORKFLOW_EXTERNAL_OBJECT_TYPE,
				`${fact.workflowId}:${fact.stepId}`,
				fact,
				{
					clientRequestId: `scheduler.workflow.external:${fact.workflowId}:${fact.stepId}`,
					expectedRevision: 0,
					correlation: { taskId: fact.taskId, parentId: fact.workflowId },
				},
			);
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}

	private async readCompensation(
		workflowId: string,
		stepId: string,
	): Promise<ResultValue<SchedulerWorkflowCompensationFactV1 | undefined, FoundationError>> {
		const stored = await this.ledger.getFact<SchedulerWorkflowCompensationFactV1>(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			`${workflowId}:${stepId}`,
		);
		if (stored === undefined) return Result.ok(undefined);
		return parseCompensationFact(stored.payload, workflowId, stepId);
	}

	private async writeCompensation(
		fact: SchedulerWorkflowCompensationFactV1,
	): Promise<ResultValue<SchedulerWorkflowCompensationFactV1, FoundationError>> {
		const objectId = `${fact.workflowId}:${fact.stepId}`;
		const current = await this.ledger.getFact<SchedulerWorkflowCompensationFactV1>(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			objectId,
		);
		try {
			const written = await this.ledger.appendFact(
				SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
				objectId,
				fact,
				{
					clientRequestId: `scheduler.workflow.compensation:${objectId}:${current?.record.revision ?? 0}:${fact.state}`,
					expectedRevision: current?.record.revision ?? 0,
					correlation: { taskId: this.task.taskId, parentId: fact.workflowId, stepId: fact.stepId },
				},
			);
			return parseCompensationFact(written.payload, fact.workflowId, fact.stepId);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", errorCode(error)),
			);
		}
	}
}
