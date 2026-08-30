/**
 * In-process ChildAgentProvider and agent-class TaskExecutorProvider.
 *
 * Spawn and receipts go through LayeredResultSettlement. Identity and
 * lifecycle stay on SubagentSupervisor. Model and tool calls use the
 * injected gateways; quota reserve/settle is ownerKind agent_executor.
 */

import {
	cloneDeepFrozen,
	createAgentInstance,
	createAttempt,
	createBindingEpoch,
	createContextSnapshot,
	FoundationError,
	FoundationObserver,
	Result,
	ScopedExecutionGateway,
	validateAgentInstance,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateChildSpawnRequest,
	validateImmutableAgentBinding,
	validateQuotaAttribution,
	validateQuotaReservation,
	type AgentBinding,
	type AgentHarness,
	type AgentInstance,
	type AttemptReceipt,
	type Attempt,
	type BindingEpoch,
	type BudgetUsage,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type ContextSnapshot,
	type Dispatch,
	type ExecutionCorrelation,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ObserverCursor,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	type ResultValue,
	type ScopedMemoryStore,
	type ScopedModelGateway,
	type Session,
	type SessionLedger,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	type ToolGateway,
} from "@aos-agent/agent-core";
import type { ChildContextForkResult } from "./context-fork.ts";
import { cleanupChildMemoryScope, createChildMemoryScope } from "./memory.ts";
import {
	projectProviderChildContext,
	type LoadParentContext,
} from "./provider-context.ts";
import { IN_PROCESS_PROVIDER } from "./registry.ts";
import type { SubagentProviderSpawnPlan, SubagentSupervisor } from "./supervisor.ts";
import { SCHEDULER_IN_PROCESS_CAPABILITY_ID } from "../scheduler/executors.ts";

export interface ChildAgentHarnessCreateInput {
	readonly session: Session;
	readonly laneId: string;
	readonly correlation: ExecutionCorrelation;
	readonly binding: AgentBinding;
	readonly epoch: BindingEpoch;
	readonly agentInstance: AgentInstance;
	readonly gateway: ScopedExecutionGateway;
	readonly memory: ScopedMemoryStore;
	/** Process-local child worktree path. This value must never be persisted. */
	readonly executionWorkspace?: string;
	readonly signal?: AbortSignal;
	readonly deadlineAt?: string;
	readonly systemPrompt?: string;
	readonly snapshot?: ContextSnapshot;
}

export interface InProcessChildAgentProviderOptions {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly supervisor: SubagentSupervisor;
	readonly quota: QuotaProvider;
	readonly modelGateway: ScopedModelGateway;
	readonly toolGateway: ToolGateway;
	readonly session: Session;
	readonly ledger: SessionLedger;
	readonly createHarness: (input: ChildAgentHarnessCreateInput) => Promise<AgentHarness>;
	readonly now?: () => string;
	readonly loadParentContext: LoadParentContext;
	readonly parentMemory: { readonly store: ScopedMemoryStore; readonly parentAgentInstanceId: string };
	readonly resolveParentMemory?: (
		parentAgentInstanceId: string,
	) => { readonly store: ScopedMemoryStore; readonly parentAgentInstanceId: string };
	readonly resolveExecutionWorkspace?: (input: {
		readonly childAgentInstanceId: string;
		readonly attemptId: string;
	}) => string | undefined;
	readonly loadTurnBoundaryContext?: (input: {
		readonly schemaVersion: 1;
		readonly spawnId: string;
		readonly attemptId: string;
		readonly childAgentInstanceId: string;
	}) => Promise<ResultValue<string | undefined, FoundationError>>;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

export interface ChildAgentBackgroundAttach {
	readonly observerId: string;
	readonly cursor: ObserverCursor;
}

interface InProcessChildHandleV1 {
	readonly spawnId: string;
	readonly spawn: ChildSpawnResult;
	readonly request: ChildSpawnRequest;
	readonly correlation: ExecutionCorrelation;
	readonly binding: AgentBinding;
	readonly childLaneId: string;
	gateway?: ScopedExecutionGateway;
	harness?: AgentHarness;
	controller?: AbortController;
	deadlineTimer?: ReturnType<typeof setTimeout>;
	quotaReservation?: QuotaReservation;
	observer?: FoundationObserver;
	memory?: ScopedMemoryStore;
	background: boolean;
	closed: boolean;
	lost: boolean;
	running?: Promise<ResultValue<AttemptReceipt, FoundationError>>;
	receipt?: AttemptReceipt;
	suspendedReceipt?: AttemptReceipt;
	contextFork?: ChildContextForkResult;
	turnCount: number;
}

const DEFAULT_CAPABILITIES: readonly FoundationProviderCapability[] = Object.freeze([
	Object.freeze({ schemaVersion: 1 as const, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 }),
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.in_process", version: 1 }),
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.resume", version: 1 }),
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.background", version: 1 }),
]);

function fail(code: ConstructorParameters<typeof FoundationError>[0], message: string): FoundationError {
	return new FoundationError(code, message);
}

function isPositiveTimeoutMs(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function attemptReceiptIsTerminalV1(status: AttemptReceipt["status"]): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

type ChildHarnessOutcomeV1 = {
	readonly kind: "completed" | "aborted" | "failed" | "suspended" | "pending";
	readonly error?: { readonly code: string; readonly message: string };
};

export function childAgentQuotaAttribution(input: {
	readonly taskId: string;
	readonly attemptId: string;
	readonly agentInstanceId: string;
	readonly providerId: string;
	readonly goalId?: string;
	readonly runId?: string;
}): ResultValue<QuotaAttribution, FoundationError> {
	const attribution: QuotaAttribution = {
		schemaVersion: 1,
		taskId: input.taskId,
		attemptId: input.attemptId,
		agentInstanceId: input.agentInstanceId,
		providerId: input.providerId,
		ownerKind: "agent_executor",
		...(input.goalId === undefined ? {} : { goalId: input.goalId }),
		...(input.runId === undefined ? {} : { runId: input.runId }),
	};
	const checked = validateQuotaAttribution(attribution);
	if (!checked.ok) {
		return Result.err(fail("quota_attribution_error", "Child Agent quota attribution is not exact"));
	}
	if (
		checked.value.ownerKind !== "agent_executor" ||
		checked.value.taskId !== input.taskId ||
		checked.value.attemptId !== input.attemptId ||
		checked.value.agentInstanceId !== input.agentInstanceId ||
		checked.value.providerId !== input.providerId
	) {
		return Result.err(fail("quota_attribution_error", "Child Agent quota attribution must identify the child executor"));
	}
	return checked;
}

export function buildAgentExecutorReceipt(input: {
	readonly attempt: Attempt;
	readonly correlation: ExecutionCorrelation;
	readonly status: AttemptReceipt["status"];
	readonly sideEffectState: AttemptReceipt["sideEffectState"];
	readonly now: string;
	readonly error?: AttemptReceipt["error"];
}): ResultValue<AttemptReceipt, FoundationError> {
	const attemptReceiptId = `attempt-receipt:${input.attempt.attemptId}`;
	const receipt: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId,
		taskId: input.attempt.taskId,
		dispatchId: input.attempt.dispatchId,
		attemptId: input.attempt.attemptId,
		providerId: input.attempt.providerId,
		...(input.attempt.agentInstanceId === undefined ? {} : { agentInstanceId: input.attempt.agentInstanceId }),
		bindingId: input.attempt.bindingId,
		bindingEpochIds: input.attempt.bindingEpochIds,
		status: input.status,
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "agent_executor",
			providerId: input.attempt.providerId,
			producedAt: input.now,
			correlation: { ...input.correlation, attemptReceiptId },
		},
		sideEffectState: input.sideEffectState,
		...(input.error === undefined ? {} : { error: input.error }),
	};
	return validateAttemptReceiptForProvider(receipt, {
		providerId: input.attempt.providerId,
		providerClass: "agent",
	});
}

export class InProcessChildAgentProvider implements ChildAgentProvider, TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "agent" as const;
	readonly providerId: string;
	private readonly supervisor: SubagentSupervisor;
	private readonly quota: QuotaProvider;
	private readonly modelGateway: ScopedModelGateway;
	private readonly toolGateway: ToolGateway;
	private readonly session: Session;
	private readonly ledger: SessionLedger;
	private readonly createHarness: (input: ChildAgentHarnessCreateInput) => Promise<AgentHarness>;
	private readonly now: () => string;
	private readonly loadParentContext: LoadParentContext;
	private readonly parentMemory: InProcessChildAgentProviderOptions["parentMemory"];
	private readonly resolveParentMemory: NonNullable<InProcessChildAgentProviderOptions["resolveParentMemory"]>;
	private readonly resolveExecutionWorkspace: NonNullable<InProcessChildAgentProviderOptions["resolveExecutionWorkspace"]>;
	private readonly loadTurnBoundaryContext: NonNullable<InProcessChildAgentProviderOptions["loadTurnBoundaryContext"]>;
	private readonly declaredCapabilities: readonly FoundationProviderCapability[];
	private readonly bySpawnId = new Map<string, InProcessChildHandleV1>();
	private readonly byAttemptId = new Map<string, InProcessChildHandleV1>();
	private disposed = false;

	constructor(options: InProcessChildAgentProviderOptions) {
		if (
			options.schemaVersion !== 1 ||
			typeof options.providerId !== "string" ||
			options.providerId.length === 0 ||
			options.quota.providerClass !== "quota" ||
			options.modelGateway.providerClass !== "gateway" ||
			options.toolGateway.providerClass !== "gateway" ||
			typeof options.createHarness !== "function" ||
			typeof options.loadParentContext !== "function" ||
			options.parentMemory.store.ownerId !== options.parentMemory.parentAgentInstanceId
			|| (options.resolveParentMemory !== undefined && typeof options.resolveParentMemory !== "function")
			|| (options.resolveExecutionWorkspace !== undefined && typeof options.resolveExecutionWorkspace !== "function")
		) {
			throw fail("subagent_spawn_invalid", "In-process Child Agent provider options are invalid");
		}
		this.providerId = options.providerId;
		this.supervisor = options.supervisor;
		this.quota = options.quota;
		this.modelGateway = options.modelGateway;
		this.toolGateway = options.toolGateway;
		this.session = options.session;
		this.ledger = options.ledger;
		this.createHarness = options.createHarness;
		this.now = options.now ?? (() => new Date().toISOString());
		this.loadParentContext = options.loadParentContext;
		this.parentMemory = options.parentMemory;
		this.resolveParentMemory = options.resolveParentMemory ?? (() => this.parentMemory);
		this.resolveExecutionWorkspace = options.resolveExecutionWorkspace ?? (() => undefined);
		this.loadTurnBoundaryContext = options.loadTurnBoundaryContext ?? (async () => Result.ok(undefined));
		this.declaredCapabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return this.declaredCapabilities;
	}

	async spawn(
		requestValue: ChildSpawnRequest,
		options: FoundationProviderExecutionOptions,
	): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
		if (this.disposed) return Result.err(fail("subagent_provider_unavailable", "In-process Child Agent provider is disposed"));
		const requestResult = validateChildSpawnRequest(requestValue);
		if (!requestResult.ok) return requestResult;
		const request = requestResult.value;
		const existing = this.bySpawnId.get(request.spawnId);
		if (existing !== undefined) {
			if (existing.lost) return Result.err(fail("subagent_lost", "Child Agent spawn handle is lost"));
			return Result.ok(cloneDeepFrozen(existing.spawn));
		}
		const planned = this.supervisor.providerSpawnPlan({ schemaVersion: 1, spawnId: request.spawnId });
		if (!planned.ok) return planned;
		if (planned.value.providerId !== this.providerId) {
			return Result.err(fail("subagent_conflict", "Child Agent spawn plan belongs to a different provider"));
		}
		const correlation = options.correlation;
		if (
			correlation === undefined ||
			correlation.taskId !== request.taskEnvelope.taskId ||
			correlation.agentInstanceId !== planned.value.childAgentInstanceId ||
			correlation.attemptId !== planned.value.attemptId ||
			correlation.dispatchId !== planned.value.dispatchId ||
			correlation.bindingId !== planned.value.bindingId ||
			correlation.bindingEpochId !== planned.value.bindingEpochId ||
			correlation.laneId !== planned.value.childLaneId
		) {
			return Result.err(fail("invalid_correlation", "Child Agent spawn correlation does not match the supervisor plan"));
		}
		if (options.signal?.aborted) {
			return Result.err(fail("subagent_cancel_failed", "Child Agent spawn was cancelled before start"));
		}
		const created = await this.createSpawnResult(request, planned.value, correlation);
		if (!created.ok) return created;
		const bindingFact = await this.ledger.get("agent_binding", planned.value.bindingId);
		if (bindingFact?.kind !== "fact") {
			return Result.err(fail("subagent_spawn_invalid", "Child AgentBinding must be durable before spawn"));
		}
		const bindingResult = validateImmutableAgentBinding(bindingFact.payload);
		if (!bindingResult.ok) return bindingResult;
		const handle: InProcessChildHandleV1 = {
			spawnId: request.spawnId,
			spawn: created.value,
			request,
			correlation,
			binding: bindingResult.value,
			childLaneId: planned.value.childLaneId,
			background: false,
			closed: false,
			lost: false,
			turnCount: 0,
		};
		const projected = await this.forkContext(handle);
		if (!projected.ok) return projected;
		handle.contextFork = projected.value;
		this.bySpawnId.set(request.spawnId, handle);
		this.byAttemptId.set(planned.value.attemptId, handle);
		const reserved = await this.reserveQuota(handle);
		if (!reserved.ok) {
			handle.lost = true;
			return reserved;
		}
		return Result.ok(cloneDeepFrozen(created.value));
	}

	async lookupSpawn(
		spawnId: string,
		_options?: { signal?: AbortSignal },
	): Promise<ResultValue<ChildSpawnResult | undefined, FoundationError>> {
		if (typeof spawnId !== "string" || spawnId.length === 0) {
			return Result.err(fail("subagent_spawn_invalid", "Child Agent spawnId is invalid"));
		}
		const handle = this.bySpawnId.get(spawnId);
		if (handle === undefined) return Result.ok(undefined);
		if (handle.lost) return Result.err(fail("subagent_lost", "Child Agent spawn handle is lost"));
		return Result.ok(cloneDeepFrozen(handle.spawn));
	}

	async createAttempt(
		dispatch: Dispatch,
		binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<ResultValue<Attempt, FoundationError>> {
		if (context === undefined || context.agentInstance === undefined) {
			return Result.err(fail("agent_instance_required_for_agent_provider", "Agent-class createAttempt requires an AgentInstance"));
		}
		if (dispatch.taskExecutorProviderId !== this.providerId || binding.taskId !== dispatch.taskId) {
			return Result.err(fail("invalid_correlation", "Child Agent Attempt does not match its Dispatch"));
		}
		const handle = this.byAttemptId.get(context.initialBindingEpoch.attemptId);
		if (handle !== undefined) {
			const existing = handle.spawn.attempt;
			if (
				existing.dispatchId !== dispatch.dispatchId ||
				existing.taskId !== dispatch.taskId ||
				existing.bindingId !== binding.bindingId
			) {
				return Result.err(fail("subagent_conflict", "Child Agent Attempt identity collides"));
			}
			return Result.ok(cloneDeepFrozen(existing));
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: "agent",
			agentInstanceId: context.agentInstance.agentInstanceId,
			now: this.now,
		});
	}

	async runAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const attemptResult = validateAttempt(attempt);
		if (!attemptResult.ok) return attemptResult;
		const handle = this.byAttemptId.get(attemptResult.value.attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.lost) return Result.err(fail("subagent_lost", "Child Agent handle is lost"));
		if (handle.closed) return Result.err(fail("subagent_conflict", "Child Agent handle is closed"));
		if (handle.receipt !== undefined) return Result.ok(cloneDeepFrozen(handle.receipt));
		if (handle.running !== undefined) return handle.running;
		if (handle.suspendedReceipt !== undefined) return Result.ok(cloneDeepFrozen(handle.suspendedReceipt));
		const run = this.executeAttempt(handle, attemptResult.value, options, false);
		handle.running = run;
		try {
			return await run;
		} finally {
			if (handle.running === run) handle.running = undefined;
		}
	}

	async cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		return this.cancel(attemptId);
	}

	async cancel(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		if (typeof attemptId !== "string" || attemptId.length === 0) {
			return Result.err(fail("subagent_spawn_invalid", "Child Agent attemptId is invalid"));
		}
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.closed || handle.receipt !== undefined) return Result.ok(undefined);
		handle.controller?.abort();
		if (handle.harness !== undefined) {
			try {
				await handle.harness.abort();
			} catch {
				handle.lost = true;
				await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
				return Result.err(fail("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
			}
		}
		return Result.ok(undefined);
	}

	async resume(
		attemptId: string,
		options?: { signal?: AbortSignal },
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.lost) return Result.err(fail("subagent_lost", "Child Agent handle is lost"));
		if (handle.closed) return Result.err(fail("subagent_resume_failed", "Child Agent handle is closed"));
		if (handle.receipt !== undefined && attemptReceiptIsTerminalV1(handle.receipt.status)) {
			return Result.ok(cloneDeepFrozen(handle.receipt));
		}
		handle.suspendedReceipt = undefined;
		const executionOptions: FoundationProviderExecutionOptions = {
			correlation: handle.correlation,
			...(options?.signal === undefined ? {} : { signal: options.signal }),
		};
		if (handle.harness !== undefined) {
			return this.continueExistingHarness(handle, handle.spawn.attempt, executionOptions);
		}
		if (handle.running !== undefined) return handle.running;
		const run = this.executeAttempt(handle, handle.spawn.attempt, executionOptions, true);
		handle.running = run;
		try {
			return await run;
		} finally {
			if (handle.running === run) handle.running = undefined;
		}
	}

	async markBackground(attemptId: string): Promise<ResultValue<ChildAgentBackgroundAttach, FoundationError>> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		const background = await this.supervisor.markBackground(handle.spawn.agentInstance.agentInstanceId);
		if (!background.ok) return background;
		handle.background = true;
		const observer = handle.observer ?? new FoundationObserver();
		handle.observer = observer;
		const attached = observer.attach(handle.correlation.sessionId);
		if (!attached.ok) return Result.err(fail("subagent_conflict", attached.error.message));
		return Result.ok({ observerId: attached.value.observerId, cursor: attached.value.cursor });
	}

	attachObserver(
		attemptId: string,
		cursor?: ObserverCursor,
	): ResultValue<ChildAgentBackgroundAttach, FoundationError> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		const observer = handle.observer ?? new FoundationObserver();
		handle.observer = observer;
		if (observer.currentPhase !== "idle" && observer.currentPhase !== "gap") {
			if (cursor === undefined) {
				const current = observer.currentCursor;
				const id = observer.currentObserverId;
				if (current === undefined || id === undefined) {
					return Result.err(fail("subagent_conflict", "Child Agent observer is not attached"));
				}
				return Result.ok({ observerId: id, cursor: current });
			}
			const reconnected = observer.reconnect(cursor);
			if (!reconnected.ok) return Result.err(fail("subagent_conflict", reconnected.error.message));
			return Result.ok({ observerId: observer.currentObserverId ?? "observer", cursor: reconnected.value.cursor });
		}
		const attached = observer.attach(handle.correlation.sessionId, cursor);
		if (!attached.ok) return Result.err(fail("subagent_conflict", attached.error.message));
		return Result.ok({ observerId: attached.value.observerId, cursor: attached.value.cursor });
	}

	async close(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		return this.releaseHandle(handle);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const handles = [...this.byAttemptId.values()];
		for (const handle of handles) {
			await this.releaseHandle(handle);
		}
		this.byAttemptId.clear();
		this.bySpawnId.clear();
	}

	private async createSpawnResult(
		request: ChildSpawnRequest,
		plan: SubagentProviderSpawnPlan,
		correlation: ExecutionCorrelation,
	): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
		if (request.parentAgentInstanceId === undefined) {
			return Result.err(fail("subagent_spawn_invalid", "Child Agent spawn requires a parent AgentInstance"));
		}
		const parentFact = await this.ledger.get("agent_instance", request.parentAgentInstanceId);
		if (parentFact?.kind !== "fact") {
			return Result.err(fail("subagent_spawn_invalid", "Child Agent parent AgentInstance must be durable"));
		}
		const parent = validateAgentInstance(parentFact.payload);
		if (!parent.ok) return parent;
		const createdAgent = createAgentInstance({
			agentInstanceId: plan.childAgentInstanceId,
			providerId: this.providerId,
			providerDeclaredAgent: true,
			roleRevision: request.roleRevision,
			taskId: request.taskEnvelope.taskId,
			parent: parent.value,
			now: this.now,
		});
		if (!createdAgent.ok) return createdAgent;
		const createdEpoch = createBindingEpoch({
			bindingEpochId: plan.bindingEpochId,
			taskId: request.taskEnvelope.taskId,
			attemptId: plan.attemptId,
			agentInstanceId: createdAgent.value.agentInstanceId,
			bindingId: plan.bindingId,
			activationReason: "attempt_started",
			activatedByCommandId: `command:${request.spawnId}`,
			now: this.now,
		});
		if (!createdEpoch.ok) return createdEpoch;
		const dispatch: Dispatch = {
			schemaVersion: 1,
			dispatchId: plan.dispatchId,
			taskId: request.taskEnvelope.taskId,
			bindingId: plan.bindingId,
			taskExecutorProviderId: this.providerId,
			status: "pending",
			createdAt: this.now(),
		};
		const createdAttempt = createAttempt({
			attemptId: plan.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: createdEpoch.value,
			providerClass: "agent",
			agentInstanceId: createdAgent.value.agentInstanceId,
			now: this.now,
		});
		if (!createdAttempt.ok) return createdAttempt;
		if (
			createdAttempt.value.attemptId !== correlation.attemptId ||
			createdAgent.value.agentInstanceId !== correlation.agentInstanceId
		) {
			return Result.err(fail("invalid_correlation", "Child Agent spawn identities do not match correlation"));
		}
		return Result.ok({
			schemaVersion: 1,
			attempt: createdAttempt.value,
			agentInstance: createdAgent.value,
			initialBindingEpoch: createdEpoch.value,
		});
	}

	private async executeAttempt(
		handle: InProcessChildHandleV1,
		attempt: Attempt,
		options: FoundationProviderExecutionOptions | undefined,
		resume: boolean,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (handle.quotaReservation === undefined) {
			const reserved = await this.reserveQuota(handle);
			if (!reserved.ok) return reserved;
		}
		const controller = new AbortController();
		handle.controller = controller;
		const onAbort = (): void => controller.abort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) controller.abort();
		const deadlineAt = handle.request.taskEnvelope.requirements?.deadlineAt;
		if (deadlineAt !== undefined) {
			const remaining = Date.parse(deadlineAt) - Date.now();
			if (!Number.isFinite(remaining) || remaining <= 0) {
				options?.signal?.removeEventListener("abort", onAbort);
				return this.finishAttempt(handle, attempt, "failed", "none", {
					code: "subagent_spawn_invalid",
					message: "Child Agent deadline has elapsed",
					retryable: false,
				});
			}
			if (isPositiveTimeoutMs(Math.ceil(remaining))) {
				handle.deadlineTimer = setTimeout(() => controller.abort(), remaining);
			}
		}
		try {
			const snapshot = resume ? await this.resumeContext(handle) : await this.forkContext(handle);
			if (!snapshot.ok) return snapshot;
			const requestedParentId = handle.request.parentAgentInstanceId;
			if (requestedParentId === undefined) {
				return Result.err(fail("subagent_spawn_invalid", "Child Agent parent memory authority does not match the parent identity"));
			}
			const parentMemory = this.resolveParentMemory(requestedParentId);
			if (
				parentMemory.parentAgentInstanceId !== requestedParentId ||
				parentMemory.store.ownerId !== requestedParentId
			) {
				return Result.err(fail("subagent_spawn_invalid", "Child Agent parent memory authority does not match the parent identity"));
			}
			if (handle.memory === undefined) {
				handle.memory = createChildMemoryScope(
					parentMemory.store,
					handle.spawn.agentInstance.agentInstanceId,
					parentMemory.parentAgentInstanceId,
				);
			}
			const gateway = new ScopedExecutionGateway({
				model: this.modelGateway,
				tool: this.toolGateway,
				binding: handle.binding,
				epoch: handle.spawn.initialBindingEpoch,
				providerClass: "agent",
				budget: handle.request.taskEnvelope.budget,
			});
			handle.gateway = gateway;
			const executionWorkspace = this.resolveExecutionWorkspace({
				childAgentInstanceId: handle.spawn.agentInstance.agentInstanceId,
				attemptId: handle.spawn.attempt.attemptId,
			});
			const harness = await this.createHarness({
				session: this.session,
				laneId: handle.childLaneId,
				correlation: handle.correlation,
				binding: handle.binding,
				epoch: handle.spawn.initialBindingEpoch,
				agentInstance: handle.spawn.agentInstance,
				gateway,
				memory: handle.memory,
				...(executionWorkspace === undefined ? {} : { executionWorkspace }),
				signal: controller.signal,
				...(deadlineAt === undefined ? {} : { deadlineAt }),
				systemPrompt: snapshot.value.runtimeProjection.persona,
				snapshot: snapshot.value.snapshot,
			});
			handle.harness = harness;
			if (controller.signal.aborted) {
				await harness.abort().catch(() => undefined);
				return this.finishAttempt(handle, attempt, "cancelled", "none");
			}
			if (resume) {
				const resumed = await this.invokeChildResume(harness, handle);
				if (!resumed.ok) return resumed;
				return this.applyHarnessOutcome(handle, attempt, controller, resumed);
			}
			const prompted = await this.invokeChildPrompt(harness, handle);
			return this.applyHarnessOutcome(handle, attempt, controller, prompted);
		} catch (error) {
			await this.cleanupMemory(handle);
			if (controller.signal.aborted) return this.finishAttempt(handle, attempt, "cancelled", "none");
			handle.lost = true;
			await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
			return Result.err(
				error instanceof FoundationError
					? error
					: fail("subagent_lost", "Child Agent in-process execution was lost"),
			);
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			if (handle.deadlineTimer !== undefined) {
				clearTimeout(handle.deadlineTimer);
				handle.deadlineTimer = undefined;
			}
		}
	}

	private async continueExistingHarness(
		handle: InProcessChildHandleV1,
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const harness = handle.harness;
		if (harness === undefined) {
			return Result.err(fail("subagent_resume_failed", "Child Agent transcript could not be resumed"));
		}
		const controller = new AbortController();
		handle.controller = controller;
		const onAbort = (): void => controller.abort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) controller.abort();
		const run = (async (): Promise<ResultValue<AttemptReceipt, FoundationError>> => {
			try {
				if (controller.signal.aborted) {
					await harness.abort().catch(() => undefined);
					return this.finishAttempt(handle, attempt, "cancelled", "none");
				}
				const resumed = await this.invokeChildResume(harness, handle);
				if (!resumed.ok) {
					handle.lost = true;
					await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
					const cleaned = await this.cleanupMemory(handle);
					return cleaned.ok
						? Result.err(fail("subagent_resume_failed", "Child Agent transcript could not be resumed"))
						: cleaned;
				}
				return this.applyHarnessOutcome(handle, attempt, controller, resumed);
			} catch (error) {
				if (controller.signal.aborted) return this.finishAttempt(handle, attempt, "cancelled", "none");
				handle.lost = true;
				await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
				const cleaned = await this.cleanupMemory(handle);
				if (!cleaned.ok) return cleaned;
				return Result.err(
					error instanceof FoundationError
						? error
						: fail("subagent_resume_failed", "Child Agent transcript could not be resumed"),
				);
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
			}
		})();
		handle.running = run;
		try {
			return await run;
		} finally {
			if (handle.running === run) handle.running = undefined;
		}
	}

	private async ensureChildLane(harness: AgentHarness, laneId: string): Promise<void> {
		if (typeof harness.createLane !== "function") return;
		await harness.createLane(laneId, null);
	}

	private async invokeChildPrompt(
		harness: AgentHarness,
		handle: InProcessChildHandleV1,
	): Promise<ResultValue<ChildHarnessOutcomeV1, FoundationError>> {
		const recorded = await this.supervisor.recordTurn({
			schemaVersion: 1,
			childAgentInstanceId: handle.spawn.agentInstance.agentInstanceId,
			expectedTurnCount: handle.turnCount,
		});
		if (!recorded.ok) return recorded;
		handle.turnCount = recorded.value;
		const boundary = await this.loadTurnBoundaryContext({
			schemaVersion: 1,
			spawnId: handle.spawnId,
			attemptId: handle.spawn.attempt.attemptId,
			childAgentInstanceId: handle.spawn.agentInstance.agentInstanceId,
		});
		if (!boundary.ok) return boundary;
		const prompt = boundary.value === undefined
			? handle.request.taskEnvelope.goal
			: `${handle.request.taskEnvelope.goal}\n\nChild mailbox messages at this turn boundary:\n${boundary.value}`;
		await this.ensureChildLane(harness, handle.childLaneId);
		const prompted =
			typeof harness.promptOnLane === "function"
				? await harness.promptOnLane(handle.childLaneId, prompt)
				: await harness.prompt(prompt);
		if (!prompted.ok) return Result.err(fail("subagent_lost", "Child Agent loop rejected the prompt"));
		return Result.ok({
			kind: prompted.value.kind,
			...("error" in prompted.value && prompted.value.error !== undefined ? { error: prompted.value.error } : {}),
		});
	}

	private async invokeChildResume(
		harness: AgentHarness,
		handle: InProcessChildHandleV1,
	): Promise<ResultValue<ChildHarnessOutcomeV1, FoundationError>> {
		await this.ensureChildLane(harness, handle.childLaneId);
		const resumed =
			typeof harness.resumeOnLane === "function"
				? await harness.resumeOnLane(handle.childLaneId)
				: await harness.resume();
		if (!resumed.ok) return Result.err(fail("subagent_resume_failed", "Child Agent transcript could not be resumed"));
		if (resumed.value.operation !== "run") {
			return Result.err(fail("subagent_resume_failed", "Child Agent transcript could not be resumed"));
		}
		return Result.ok({
			kind: resumed.value.kind,
			...("error" in resumed.value && resumed.value.error !== undefined ? { error: resumed.value.error } : {}),
		});
	}

	private async applyHarnessOutcome(
		handle: InProcessChildHandleV1,
		attempt: Attempt,
		controller: AbortController,
		outcome: ResultValue<ChildHarnessOutcomeV1, FoundationError>,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (!outcome.ok) {
			if (controller.signal.aborted) return this.finishAttempt(handle, attempt, "cancelled", "none");
			return this.finishAttempt(handle, attempt, "failed", "none", {
				code: outcome.error.code,
				message: outcome.error.message,
				retryable: false,
			});
		}
		if (outcome.value.kind === "aborted" || controller.signal.aborted) {
			return this.finishAttempt(handle, attempt, "cancelled", "none");
		}
		if (outcome.value.kind === "failed") {
			return this.finishAttempt(handle, attempt, "failed", "side_effect_unknown", {
				code: outcome.value.error?.code ?? "subagent_lost",
				message: outcome.value.error?.message ?? "Child Agent loop failed",
				retryable: false,
			});
		}
		if (outcome.value.kind === "suspended") {
			return this.finishAttempt(handle, attempt, "suspended", "none");
		}
		if (outcome.value.kind !== "completed") {
			return this.finishAttempt(handle, attempt, "failed", "side_effect_unknown", {
				code: "subagent_lost",
				message: "Child Agent loop did not reach a terminal outcome",
				retryable: false,
			});
		}
		return this.finishAttempt(handle, attempt, "succeeded", "none");
	}

	private async resumeContext(handle: InProcessChildHandleV1): Promise<ResultValue<ChildContextForkResult, FoundationError>> {
		const base = await this.forkContext(handle);
		if (!base.ok) return base;
		try {
			const lanes = await this.session.getLanes();
			if (!lanes.some((item) => item.lane === handle.childLaneId)) {
				return Result.err(fail("subagent_resume_failed", "Child Agent child-lane transcript is missing"));
			}
			const entries = await this.session.view(handle.childLaneId).findEntriesOnBranch({ order: "oldestFirst" });
			if (entries.length === 0) {
				return Result.err(fail("subagent_resume_failed", "Child Agent child-lane transcript is missing"));
			}
			return Result.ok({
				...base.value,
				snapshot: createContextSnapshot(entries, {
					bindingEpochId: handle.spawn.initialBindingEpoch.bindingEpochId,
					forkMode: "none",
					source: { sourceId: handle.spawnId, kind: "system", trust: "builtin" },
					budget: { maxTokens: handle.request.taskEnvelope.budget.tokens ?? 1000 },
				}),
			});
		} catch {
			return Result.err(fail("subagent_resume_failed", "Child Agent child-lane transcript could not be read"));
		}
	}

	private async forkContext(handle: InProcessChildHandleV1): Promise<ResultValue<ChildContextForkResult, FoundationError>> {
		if (handle.contextFork !== undefined) return Result.ok(handle.contextFork);
		const projected = await projectProviderChildContext({
			schemaVersion: 1,
			request: handle.request,
			childBindingEpochId: handle.spawn.initialBindingEpoch.bindingEpochId,
			loadParentContext: this.loadParentContext,
		});
		if (projected.ok) handle.contextFork = projected.value;
		return projected;
	}

	private async reserveQuota(handle: InProcessChildHandleV1): Promise<ResultValue<QuotaReservation, FoundationError>> {
		const attribution = childAgentQuotaAttribution({
			taskId: handle.spawn.attempt.taskId,
			attemptId: handle.spawn.attempt.attemptId,
			agentInstanceId: handle.spawn.agentInstance.agentInstanceId,
			providerId: this.providerId,
			goalId: handle.request.taskEnvelope.goalId,
		});
		if (!attribution.ok) return attribution;
		try {
			const reserved = await this.quota.reserve(attribution.value, handle.request.taskEnvelope.budget);
			if (!reserved.ok) return reserved;
			const checked = validateQuotaReservation(reserved.value);
			if (!checked.ok) return Result.err(fail("quota_attribution_error", "Child Agent quota reservation is not exact"));
			if (
				checked.value.attribution.ownerKind !== "agent_executor" ||
				checked.value.attribution.taskId !== handle.spawn.attempt.taskId ||
				checked.value.attribution.attemptId !== handle.spawn.attempt.attemptId ||
				checked.value.attribution.agentInstanceId !== handle.spawn.agentInstance.agentInstanceId ||
				checked.value.attribution.providerId !== this.providerId
			) {
				return Result.err(fail("quota_attribution_error", "Child Agent quota reservation attribution is not exact"));
			}
			handle.quotaReservation = checked.value;
			return checked;
		} catch (error) {
			return Result.err(
				error instanceof FoundationError ? error : fail("quota_exceeded", "Child Agent quota reserve failed closed"),
			);
		}
	}

	private async settleQuota(handle: InProcessChildHandleV1, usage: BudgetUsage): Promise<ResultValue<BudgetUsage, FoundationError>> {
		if (handle.quotaReservation === undefined) {
			return Result.err(fail("quota_attribution_error", "Child Agent quota was not reserved"));
		}
		try {
			const settled = await this.quota.settle(handle.quotaReservation, usage);
			if (!settled.ok) return settled;
			return Result.ok(settled.value);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError ? error : fail("quota_exceeded", "Child Agent quota settle failed closed"),
			);
		}
	}

	private async finishAttempt(
		handle: InProcessChildHandleV1,
		attempt: Attempt,
		status: AttemptReceipt["status"],
		sideEffectState: AttemptReceipt["sideEffectState"],
		error?: AttemptReceipt["error"],
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const receipt = buildAgentExecutorReceipt({
			attempt,
			correlation: handle.correlation,
			status,
			sideEffectState,
			now: this.now(),
			...(error === undefined ? {} : { error }),
		});
		if (!receipt.ok) {
			handle.lost = true;
			await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
			const cleaned = await this.cleanupMemory(handle);
			if (!cleaned.ok) return cleaned;
			return Result.err(fail("subagent_lost", "Child Agent produced an illegal AttemptReceipt"));
		}
		if (status === "suspended") {
			handle.suspendedReceipt = receipt.value;
			return Result.ok(cloneDeepFrozen(receipt.value));
		}
		const usage = handle.gateway?.usage() ?? {};
		const settled = await this.settleQuota(handle, usage);
		if (!settled.ok) {
			handle.lost = true;
			await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
			const cleaned = await this.cleanupMemory(handle);
			if (!cleaned.ok) return cleaned;
			return settled;
		}
		handle.receipt = receipt.value;
		handle.suspendedReceipt = undefined;
		if (status === "failed" || status === "cancelled") {
			const cleaned = await this.cleanupMemory(handle);
			if (!cleaned.ok) return cleaned;
		}
		return Result.ok(cloneDeepFrozen(receipt.value));
	}

	private async cleanupMemory(handle: InProcessChildHandleV1): Promise<ResultValue<void, FoundationError>> {
		if (handle.memory === undefined) return Result.ok(undefined);
		const cleaned = await cleanupChildMemoryScope(handle.memory);
		if (!cleaned.ok) return cleaned;
		handle.memory = undefined;
		return Result.ok(undefined);
	}

	private async releaseHandle(handle: InProcessChildHandleV1): Promise<ResultValue<void, FoundationError>> {
		if (handle.closed) return Result.ok(undefined);
		handle.closed = true;
		if (handle.deadlineTimer !== undefined) {
			clearTimeout(handle.deadlineTimer);
			handle.deadlineTimer = undefined;
		}
		handle.controller?.abort();
		handle.observer?.close();
		handle.observer = undefined;
		if (handle.harness !== undefined) {
			try {
				await handle.harness.close();
			} catch {
				const cleaned = await this.cleanupMemory(handle);
				return cleaned.ok
					? Result.err(fail("subagent_close_unknown", "Child Agent harness close failed"))
					: cleaned;
			}
			handle.harness = undefined;
		}
		return this.cleanupMemory(handle);
	}
}

export const IN_PROCESS_CHILD_AGENT_PROVIDER_ID = IN_PROCESS_PROVIDER.descriptor.providerId;
