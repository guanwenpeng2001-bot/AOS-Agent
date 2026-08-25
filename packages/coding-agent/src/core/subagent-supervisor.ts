/**
 * Durable Host-side coordination for Child Agent identities and lifecycle.
 *
 * This module plans the Foundation Task/Dispatch/AgentInstance correlation and
 * delegates provider side effects to LayeredResultSettlementV1. It never
 * settles TaskResultV1 or RunReceiptV1.
 */

import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	createAgentInstance,
	createBindingEpoch,
	FoundationError,
	Result,
	validateAgentInstance,
	validateAttemptReceipt,
	validateBindingEpoch,
	validateChildSpawnRequest,
	validateDispatch,
	validateEventPayloadForCategory,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
	validateAttempt,
	validateSpawnAgentIntent,
	type AgentBinding,
	type AgentInstance,
	type BindingEpoch,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type Dispatch,
	type ExecutionCorrelation,
	type LayeredResultSettlement,
	type Result as ResultValue,
	type SessionLedger,
} from "@aos-agent/agent-core";
import {
	createChildAgentRecordV1,
	isChildExecutionTerminalStatusV1,
	transitionChildAgentRecordV1,
	validateChildAgentRecordV1,
	type ChildAgentRecordV1,
	type ChildLifecycleStatusV1,
} from "./subagent.ts";
import type { SubagentProviderDescriptorV1 } from "./subagent-registry.ts";

export const SUBAGENT_LIFECYCLE_OBJECT_TYPE = "subagent.lifecycle_transitioned";
export const SUBAGENT_SUPERVISOR_CONTROL_OBJECT_TYPE = "subagent.supervisor_control";

export interface SubagentSupervisorOptionsV1 {
	readonly schemaVersion: 1;
	readonly ledger: SessionLedger;
	readonly sessionId: string;
	readonly laneId: string;
	readonly ledgerForLane: (laneId: string) => SessionLedger;
	readonly maxDepth: number;
	readonly maxConcurrent: number;
	readonly maxTurns: number;
	readonly queueCapacity: number;
	readonly maximumQueueWaitMs: number;
	readonly now?: () => string;
	readonly scheduleQueueTimeout?: (milliseconds: number, onTimeout: () => void) => () => void;
}

export interface SubagentQueuePolicyV1 {
	readonly mode: "fail" | "queue";
	readonly timeoutMs?: number;
}

export interface PlanSubagentSpawnInputV1 {
	readonly schemaVersion: 1;
	readonly request: ChildSpawnRequest;
	readonly originParentAgentInstance: AgentInstance;
	readonly originParentAttemptId: string;
	readonly lineageParentAgentInstance?: AgentInstance;
	readonly childLaneId: string;
	readonly childBinding: AgentBinding;
	readonly providerDescriptor: SubagentProviderDescriptorV1;
	readonly childAgentInstanceId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly activatedByCommandId: string;
	readonly queue: SubagentQueuePolicyV1;
	readonly maxTurns?: number;
	readonly parentDeadlineAt?: string;
}

export interface SubagentSpawnPlanV1 {
	readonly schemaVersion: 1;
	readonly request: ChildSpawnRequest;
	readonly childBinding: AgentBinding;
	readonly dispatch: Dispatch;
	readonly agentInstance: AgentInstance;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
	readonly childLaneId: string;
	readonly providerKind: SubagentProviderDescriptorV1["providerKind"];
	readonly providerId: string;
	readonly maxTurns: number;
	readonly deadlineAt?: string;
}

export interface ChildAgentRosterEntryV1 {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly ancestorIds: readonly string[];
	readonly depth: number;
	readonly taskId: string;
	readonly attemptId: string;
	readonly providerId: string;
	readonly providerKind: ChildAgentRecordV1["providerKind"];
	readonly status: ChildLifecycleStatusV1;
	readonly mailboxAddress: string;
}

export interface SubagentProviderSpawnPlanV1 {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly childLaneId: string;
	readonly childAgentInstanceId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly providerId: string;
}

interface SubagentSupervisorControlV1 {
	readonly schemaVersion: 1;
	readonly childAgentInstanceId: string;
	readonly spawnId: string;
	readonly childLaneId: string;
	readonly originParentAgentInstanceId: string;
	readonly originParentTaskId: string;
	readonly originParentAttemptId: string;
	readonly lineageParentAgentInstanceId: string;
	readonly reparented: boolean;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly providerId: string;
	readonly maxTurns: number;
	readonly turnCount: number;
	readonly recoveryRequired: boolean;
	readonly resumeAllowed: boolean;
	readonly resumeCount: number;
	readonly revision: number;
	readonly deadlineAt?: string;
	readonly suspensionReason?: "max_turns";
	readonly updatedAt: string;
}

interface QueueWaiter {
	readonly spawnId: string;
	readonly concurrencyLimit: number;
	readonly resolve: (result: ResultValue<void, FoundationError>) => void;
	readonly cancelTimeout: () => void;
}

const PLAN_INPUT_KEYS = new Set([
	"schemaVersion",
	"request",
	"originParentAgentInstance",
	"originParentAttemptId",
	"lineageParentAgentInstance",
	"childLaneId",
	"childBinding",
	"providerDescriptor",
	"childAgentInstanceId",
	"dispatchId",
	"attemptId",
	"bindingEpochId",
	"activatedByCommandId",
	"queue",
	"maxTurns",
	"parentDeadlineAt",
]);
const QUEUE_KEYS = new Set(["mode", "timeoutMs"]);
const SPAWN_PLAN_KEYS = new Set([
	"schemaVersion",
	"request",
	"childBinding",
	"dispatch",
	"agentInstance",
	"initialBindingEpoch",
	"correlation",
	"childLaneId",
	"providerKind",
	"providerId",
	"maxTurns",
	"deadlineAt",
]);
const CONTROL_KEYS = new Set([
	"schemaVersion",
	"childAgentInstanceId",
	"spawnId",
	"childLaneId",
	"originParentAgentInstanceId",
	"originParentTaskId",
	"originParentAttemptId",
	"lineageParentAgentInstanceId",
	"reparented",
	"dispatchId",
	"attemptId",
	"bindingId",
	"bindingEpochId",
	"providerId",
	"maxTurns",
	"turnCount",
	"recoveryRequired",
	"resumeAllowed",
	"resumeCount",
	"revision",
	"deadlineAt",
	"suspensionReason",
	"updatedAt",
]);
const PROVIDER_DESCRIPTOR_KEYS = new Set([
	"schemaVersion",
	"providerKind",
	"descriptor",
	"revision",
	"capabilities",
	"implementedInThisLine",
]);
const PROVIDER_CAPABILITY_KEYS = new Set([
	"resumeSupported",
	"mailboxSupported",
	"backgroundSupported",
	"worktreeSupported",
	"maxDepth",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTIVE_STATUSES = new Set<ChildLifecycleStatusV1>([
	"spawning",
	"running",
	"awaiting_input",
	"background",
	"cancelling",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateLineage(agent: AgentInstance): boolean {
	const lineage = agent.lineage;
	if (lineage.entityType !== "agent_instance" || lineage.entityId !== agent.agentInstanceId) return false;
	const ancestors = lineage.ancestorIds ?? [];
	if (lineage.depth !== ancestors.length || new Set(ancestors).size !== ancestors.length) return false;
	if (lineage.depth === 0) return lineage.parentId === undefined && ancestors.length === 0;
	return lineage.parentId !== undefined && ancestors.at(-1) === lineage.parentId && !ancestors.includes(agent.agentInstanceId);
}

function validateProviderDescriptor(value: unknown): value is SubagentProviderDescriptorV1 {
	if (!isRecord(value) || !exactKeys(value, PROVIDER_DESCRIPTOR_KEYS)) return false;
	if (
		value.schemaVersion !== 1 ||
		!["in_process", "fork", "agent_runtime_host", "acp", "sdk"].includes(value.providerKind as string) ||
		!isPositiveInteger(value.revision) ||
		typeof value.implementedInThisLine !== "boolean" ||
		!isRecord(value.descriptor) ||
		!exactKeys(value.descriptor, new Set(["schemaVersion", "providerId", "providerClass"])) ||
		value.descriptor.schemaVersion !== 1 ||
		!isIdentifier(value.descriptor.providerId) ||
		value.descriptor.providerClass !== "agent" ||
		!isRecord(value.capabilities) ||
		!exactKeys(value.capabilities, PROVIDER_CAPABILITY_KEYS)
	) {
		return false;
	}
	return (
		typeof value.capabilities.resumeSupported === "boolean" &&
		typeof value.capabilities.mailboxSupported === "boolean" &&
		typeof value.capabilities.backgroundSupported === "boolean" &&
		typeof value.capabilities.worktreeSupported === "boolean" &&
		isPositiveInteger(value.capabilities.maxDepth)
	);
}

function validateControl(value: unknown): value is SubagentSupervisorControlV1 {
	return (
		isRecord(value) &&
		exactKeys(value, CONTROL_KEYS) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.childAgentInstanceId) &&
		isIdentifier(value.spawnId) &&
		isIdentifier(value.childLaneId) &&
		isIdentifier(value.originParentAgentInstanceId) &&
		isIdentifier(value.originParentTaskId) &&
		isIdentifier(value.originParentAttemptId) &&
		isIdentifier(value.lineageParentAgentInstanceId) &&
		typeof value.reparented === "boolean" &&
		isIdentifier(value.dispatchId) &&
		isIdentifier(value.attemptId) &&
		isIdentifier(value.bindingId) &&
		isIdentifier(value.bindingEpochId) &&
		isIdentifier(value.providerId) &&
		isPositiveInteger(value.maxTurns) &&
		isNonNegativeInteger(value.turnCount) &&
		value.turnCount <= value.maxTurns &&
		typeof value.recoveryRequired === "boolean" &&
		typeof value.resumeAllowed === "boolean" &&
		isNonNegativeInteger(value.resumeCount) &&
		isNonNegativeInteger(value.revision) &&
		(value.deadlineAt === undefined || isCanonicalTimestamp(value.deadlineAt)) &&
		(value.suspensionReason === undefined || value.suspensionReason === "max_turns") &&
		isCanonicalTimestamp(value.updatedAt)
	);
}

function validatePlanInputShape(value: unknown): value is PlanSubagentSpawnInputV1 {
	if (!isRecord(value) || !exactKeys(value, PLAN_INPUT_KEYS) || value.schemaVersion !== 1) return false;
	if (
		!isIdentifier(value.childAgentInstanceId) ||
		!isIdentifier(value.dispatchId) ||
		!isIdentifier(value.attemptId) ||
		!isIdentifier(value.bindingEpochId) ||
		!isIdentifier(value.activatedByCommandId) ||
		!isIdentifier(value.originParentAttemptId) ||
		!isIdentifier(value.childLaneId) ||
		(value.maxTurns !== undefined && !isPositiveInteger(value.maxTurns)) ||
		(value.parentDeadlineAt !== undefined && !isCanonicalTimestamp(value.parentDeadlineAt)) ||
		!isRecord(value.queue) ||
		!exactKeys(value.queue, QUEUE_KEYS) ||
		(value.queue.mode !== "fail" && value.queue.mode !== "queue") ||
		(value.queue.timeoutMs !== undefined && !isPositiveInteger(value.queue.timeoutMs)) ||
		(value.queue.mode === "fail" && value.queue.timeoutMs !== undefined) ||
		(value.queue.mode === "queue" && value.queue.timeoutMs === undefined)
	) {
		return false;
	}
	return validateProviderDescriptor(value.providerDescriptor);
}

function lineageParentAllowed(origin: AgentInstance, lineageParent: AgentInstance): boolean {
	if (origin.agentInstanceId === lineageParent.agentInstanceId) {
		return canonicalFoundationJson(origin.lineage) === canonicalFoundationJson(lineageParent.lineage);
	}
	const originAncestors = origin.lineage.ancestorIds ?? [];
	const targetIndex = originAncestors.indexOf(lineageParent.agentInstanceId);
	if (targetIndex < 0) return false;
	const expectedPrefix = originAncestors.slice(0, targetIndex);
	return canonicalFoundationJson(lineageParent.lineage.ancestorIds ?? []) === canonicalFoundationJson(expectedPrefix);
}

function childDeadline(request: ChildSpawnRequest, parentDeadlineAt: string | undefined): ResultValue<string | undefined, FoundationError> {
	const requested = request.taskEnvelope.requirements?.deadlineAt;
	if (requested !== undefined && !isCanonicalTimestamp(requested)) {
		return Result.err(new FoundationError("subagent_spawn_invalid", "Child deadline is invalid"));
	}
	if (requested !== undefined && parentDeadlineAt !== undefined && requested > parentDeadlineAt) {
		return Result.err(new FoundationError("subagent_spawn_invalid", "Child deadline cannot exceed the parent deadline"));
	}
	return Result.ok(requested ?? parentDeadlineAt);
}

function sameSpawnResultIdentity(plan: SubagentSpawnPlanV1, result: ChildSpawnResult): boolean {
	return (
		result.attempt.attemptId === plan.initialBindingEpoch.attemptId &&
		result.attempt.dispatchId === plan.dispatch.dispatchId &&
		result.attempt.taskId === plan.dispatch.taskId &&
		result.attempt.bindingId === plan.childBinding.bindingId &&
		result.attempt.providerId === plan.providerId &&
		result.attempt.agentInstanceId === plan.agentInstance.agentInstanceId &&
		result.agentInstance.agentInstanceId === plan.agentInstance.agentInstanceId &&
		result.agentInstance.lineage.parentId === plan.agentInstance.lineage.parentId &&
		canonicalFoundationJson(result.agentInstance.lineage.ancestorIds ?? []) ===
			canonicalFoundationJson(plan.agentInstance.lineage.ancestorIds ?? []) &&
		result.initialBindingEpoch.bindingEpochId === plan.initialBindingEpoch.bindingEpochId
	);
}

/**
 * Supervisor state is rebuilt exclusively from the Session ledger. In-memory
 * maps contain no provider handle or terminal authority.
 */
export class SubagentSupervisorV1 {
	private readonly ledger: SessionLedger;
	private readonly ledgerForLane: (laneId: string) => SessionLedger;
	private readonly sessionId: string;
	private readonly laneId: string;
	private readonly maxDepth: number;
	private readonly maxConcurrent: number;
	private readonly maxTurns: number;
	private readonly queueCapacity: number;
	private readonly maximumQueueWaitMs: number;
	private readonly now: () => string;
	private readonly scheduleQueueTimeout: (milliseconds: number, onTimeout: () => void) => () => void;
	private readonly records = new Map<string, ChildAgentRecordV1>();
	private readonly controls = new Map<string, SubagentSupervisorControlV1>();
	private readonly queue: QueueWaiter[] = [];
	private readonly spawnReservations = new Set<string>();
	private readonly childReservations = new Set<string>();
	private readonly laneReservations = new Set<string>();
	private readonly slotReservations = new Set<string>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SubagentSupervisorOptionsV1) {
		if (
			options.schemaVersion !== 1 ||
			!isIdentifier(options.sessionId) ||
			!isIdentifier(options.laneId) ||
			!isPositiveInteger(options.maxDepth) ||
			!isPositiveInteger(options.maxConcurrent) ||
			!isPositiveInteger(options.maxTurns) ||
			!isNonNegativeInteger(options.queueCapacity) ||
			!isPositiveInteger(options.maximumQueueWaitMs) ||
			typeof options.ledgerForLane !== "function" ||
			(options.scheduleQueueTimeout !== undefined && typeof options.scheduleQueueTimeout !== "function")
		) {
			throw new FoundationError("subagent_spawn_invalid", "Subagent supervisor options are invalid");
		}
		this.ledger = options.ledger;
		this.ledgerForLane = options.ledgerForLane;
		this.sessionId = options.sessionId;
		this.laneId = options.laneId;
		this.maxDepth = options.maxDepth;
		this.maxConcurrent = options.maxConcurrent;
		this.maxTurns = options.maxTurns;
		this.queueCapacity = options.queueCapacity;
		this.maximumQueueWaitMs = options.maximumQueueWaitMs;
		this.now = options.now ?? (() => new Date().toISOString());
		this.scheduleQueueTimeout =
			options.scheduleQueueTimeout ??
			((milliseconds, onTimeout) => {
				const timer = setTimeout(onTimeout, milliseconds);
				return () => clearTimeout(timer);
			});
	}

	async reload(): Promise<ResultValue<readonly ChildAgentRecordV1[], FoundationError>> {
		return this.serial(async () => {
			try {
				const controlFacts = await this.ledger.find({
					kind: "fact",
					objectType: SUBAGENT_SUPERVISOR_CONTROL_OBJECT_TYPE,
					order: "oldestFirst",
				});
				const rebuiltControls = new Map<string, SubagentSupervisorControlV1>();
				const foreignControlChildIds = new Set<string>();
				for (const fact of controlFacts) {
					if (fact.kind !== "fact" || fact.correlation.sessionId !== this.sessionId) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control is invalid"));
					}
					if (fact.correlation.laneId !== this.laneId) {
						if (validateControl(fact.payload)) {
							if (rebuiltControls.has(fact.payload.childAgentInstanceId)) {
								return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control ownership collides"));
							}
							foreignControlChildIds.add(fact.payload.childAgentInstanceId);
						}
						continue;
					}
					if (!validateControl(fact.payload)) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control is invalid"));
					}
					const control = fact.payload;
					if (
						foreignControlChildIds.has(control.childAgentInstanceId) ||
						fact.objectId !== control.childAgentInstanceId ||
						fact.revision !== control.revision + 1 ||
						fact.correlation.sessionId !== this.sessionId ||
						fact.correlation.laneId !== this.laneId ||
						fact.correlation.agentInstanceId !== control.childAgentInstanceId ||
						control.childLaneId === this.laneId ||
						control.maxTurns > this.maxTurns
					) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control revision is invalid"));
					}
					const previous = rebuiltControls.get(control.childAgentInstanceId);
					if (previous !== undefined && control.revision !== previous.revision + 1) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control has a revision gap"));
					}
					rebuiltControls.set(control.childAgentInstanceId, cloneDeepFrozen(control));
				}
				if (new Set([...rebuiltControls.values()].map((control) => control.childLaneId)).size !== rebuiltControls.size) {
					return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent lanes are not unique"));
				}

				const lifecycle = await this.ledger.find({
					kind: "fact",
					objectType: SUBAGENT_LIFECYCLE_OBJECT_TYPE,
					order: "oldestFirst",
				});
				const rebuilt = new Map<string, ChildAgentRecordV1>();
				const localChildLanes = new Set([...rebuiltControls.values()].map((control) => control.childLaneId));
				for (const fact of lifecycle) {
					if (fact.kind !== "fact" || fact.correlation.sessionId !== this.sessionId) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent lifecycle is invalid"));
					}
					const payloadChildId = validateChildAgentRecordV1(fact.payload)
						? fact.payload.childAgentInstanceId
						: fact.correlation.agentInstanceId;
					const ownedControl =
						payloadChildId === undefined ? undefined : rebuiltControls.get(payloadChildId);
					if (ownedControl === undefined && !localChildLanes.has(fact.correlation.laneId)) continue;
					if (!validateChildAgentRecordV1(fact.payload)) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent lifecycle is invalid"));
					}
					const record = fact.payload;
					const control = rebuiltControls.get(record.childAgentInstanceId);
					if (
						control === undefined ||
						control.spawnId !== record.spawnId ||
						control.dispatchId !== record.dispatchId ||
						control.attemptId !== record.attemptId ||
						control.bindingId !== record.bindingId ||
						control.providerId !== record.providerId ||
						control.lineageParentAgentInstanceId !== record.parentAgentInstanceId ||
						fact.objectId !== record.childAgentInstanceId ||
						fact.revision !== record.revision + 1 ||
						fact.correlation.sessionId !== this.sessionId ||
						fact.correlation.laneId !== control.childLaneId ||
						fact.correlation.agentInstanceId !== record.childAgentInstanceId ||
						fact.correlation.taskId !== record.taskId ||
						fact.correlation.dispatchId !== record.dispatchId ||
						fact.correlation.attemptId !== record.attemptId
					) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent correlation is invalid"));
					}
					const previous = rebuilt.get(record.childAgentInstanceId);
					if (previous !== undefined && record.revision !== previous.revision + 1) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent lifecycle has a revision gap"));
					}
					rebuilt.set(record.childAgentInstanceId, cloneDeepFrozen(record));
				}
				for (const childId of rebuilt.keys()) {
					if (!rebuiltControls.has(childId)) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control is missing"));
					}
				}
				if (rebuilt.size !== rebuiltControls.size) {
					return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent lifecycle/control join is incomplete"));
				}
				this.records.clear();
				this.controls.clear();
				for (const [childId, record] of rebuilt) this.records.set(childId, record);
				for (const [childId, control] of rebuiltControls) this.controls.set(childId, control);
				for (const [childId, record] of this.records) {
					const control = this.controls.get(childId);
					if (control === undefined) {
						return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child Agent control is missing"));
					}
					if (ACTIVE_STATUSES.has(record.status) && !control.recoveryRequired) {
						const persisted = await this.persistControl({
							...control,
							recoveryRequired: true,
							revision: control.revision + 1,
							updatedAt: this.now(),
						});
						if (!persisted.ok) return persisted;
					}
				}
				return Result.ok(this.list());
			} catch {
				return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent reload failed"));
			}
		});
	}

	async planSpawn(inputValue: unknown): Promise<ResultValue<SubagentSpawnPlanV1, FoundationError>> {
		if (!validatePlanInputShape(inputValue)) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent spawn plan input is invalid"));
		}
		const input = inputValue;
		if (input.childLaneId === this.laneId || [...this.controls.values()].some((control) => control.childLaneId === input.childLaneId)) {
			return Result.err(new FoundationError("subagent_conflict", "Each Child Agent requires a unique durable lane"));
		}
		const checkedRequest = validateChildSpawnRequest(input.request);
		const checkedOrigin = validateAgentInstance(input.originParentAgentInstance);
		const checkedLineageParent = validateAgentInstance(
			input.lineageParentAgentInstance ?? input.originParentAgentInstance,
		);
		const checkedBinding = validateImmutableAgentBinding(input.childBinding);
		if (!checkedRequest.ok || !checkedOrigin.ok || !checkedLineageParent.ok || !checkedBinding.ok) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent spawn plan references invalid Foundation objects"));
		}
		if (!validateLineage(checkedOrigin.value) || !validateLineage(checkedLineageParent.value)) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent parent lineage is invalid"));
		}
		if (!lineageParentAllowed(checkedOrigin.value, checkedLineageParent.value)) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Nested spawn reparent must select the origin parent or one of its proven ancestors"));
		}
		const request = checkedRequest.value;
		if (
			(request.forkScope === "recent_n") !== (request.recentN !== undefined) ||
			(request.forkScope === "task_package") !== (request.taskPackageRef !== undefined)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent fork scope fields are not exact"));
		}
		const originParent = checkedOrigin.value;
		const lineageParent = checkedLineageParent.value;
		if (
			request.parentSpawn === undefined ||
			!validateSpawnAgentIntent(request.parentSpawn).ok ||
			request.parentSpawn.parentTaskId !== originParent.taskId ||
			request.parentSpawn.newTaskEnvelopeRef.id !== request.taskEnvelope.taskId ||
			(request.parentSpawn.providerId !== undefined &&
				request.parentSpawn.providerId !== input.providerDescriptor.descriptor.providerId) ||
			request.parentAgentInstanceId !== lineageParent.agentInstanceId ||
			request.parentAttemptId !== input.originParentAttemptId ||
			request.taskEnvelope.taskId === lineageParent.taskId ||
			checkedBinding.value.taskId !== request.taskEnvelope.taskId
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent spawn identities do not match the parent Task, child Task, and Binding"));
		}
		if (!input.providerDescriptor.implementedInThisLine) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Selected Child Agent provider is unavailable"));
		}
		const depth = lineageParent.lineage.depth + 1;
		const effectiveDepth = Math.min(this.maxDepth, input.providerDescriptor.capabilities.maxDepth);
		if (depth > effectiveDepth) {
			return Result.err(new FoundationError("subagent_depth_exceeded", "Child Agent depth limit exceeded"));
		}
		const requestedMaxTurns = input.maxTurns ?? this.maxTurns;
		if (requestedMaxTurns > this.maxTurns) {
			return Result.err(new FoundationError("subagent_max_turns_exceeded", "Child Agent max-turn limit cannot exceed the Host limit"));
		}
		const deadline = childDeadline(request, input.parentDeadlineAt);
		if (!deadline.ok) return deadline;
		if (
			input.childLaneId === this.laneId ||
			this.records.has(input.childAgentInstanceId) ||
			this.controls.has(input.childAgentInstanceId) ||
			this.childReservations.has(input.childAgentInstanceId) ||
			this.laneReservations.has(input.childLaneId) ||
			this.spawnReservations.has(request.spawnId) ||
			[...this.records.values()].some((record) => record.spawnId === request.spawnId) ||
			[...this.controls.values()].some(
				(control) => control.spawnId === request.spawnId || control.childLaneId === input.childLaneId,
			)
		) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent spawn identity already exists"));
		}
		this.spawnReservations.add(request.spawnId);
		this.childReservations.add(input.childAgentInstanceId);
		this.laneReservations.add(input.childLaneId);
		try {
		const durableTask = await this.ledger.get("task", request.taskEnvelope.taskId);
		if (
			durableTask?.kind !== "fact" ||
			canonicalFoundationJson(durableTask.payload) !== canonicalFoundationJson(request.taskEnvelope)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child TaskEnvelope must be durable before spawn planning"));
		}
		const durableBinding = await this.ledger.get("agent_binding", checkedBinding.value.bindingId);
		if (
			durableBinding?.kind !== "fact" ||
			canonicalFoundationJson(durableBinding.payload) !== canonicalFoundationJson(checkedBinding.value)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child AgentBinding must be durable before spawn planning"));
		}
		const durableOrigin = await this.ledger.get("agent_instance", originParent.agentInstanceId);
		const durableLineageParent = await this.ledger.get("agent_instance", lineageParent.agentInstanceId);
		const durableOriginAttempt = await this.ledger.get("attempt", input.originParentAttemptId);
		const checkedOriginAttempt =
			durableOriginAttempt?.kind === "fact" ? validateAttempt(durableOriginAttempt.payload) : undefined;
		const expectedOriginLane = this.controls.get(originParent.agentInstanceId)?.childLaneId ?? this.laneId;
		const expectedLineageParentLane = this.controls.get(lineageParent.agentInstanceId)?.childLaneId ?? this.laneId;
		if (
			durableOrigin?.kind !== "fact" ||
			durableOrigin.objectId !== originParent.agentInstanceId ||
			durableOrigin.revision !== 1 ||
			durableOrigin.lane !== expectedOriginLane ||
			durableOrigin.correlation.sessionId !== this.sessionId ||
			durableOrigin.correlation.laneId !== expectedOriginLane ||
			durableOrigin.correlation.taskId !== originParent.taskId ||
			durableOrigin.correlation.agentInstanceId !== originParent.agentInstanceId ||
			canonicalFoundationJson(durableOrigin.payload) !== canonicalFoundationJson(originParent) ||
			durableLineageParent?.kind !== "fact" ||
			durableLineageParent.objectId !== lineageParent.agentInstanceId ||
			durableLineageParent.revision !== 1 ||
			durableLineageParent.lane !== expectedLineageParentLane ||
			durableLineageParent.correlation.sessionId !== this.sessionId ||
			durableLineageParent.correlation.laneId !== expectedLineageParentLane ||
			durableLineageParent.correlation.taskId !== lineageParent.taskId ||
			durableLineageParent.correlation.agentInstanceId !== lineageParent.agentInstanceId ||
			canonicalFoundationJson(durableLineageParent.payload) !== canonicalFoundationJson(lineageParent) ||
			durableOriginAttempt?.kind !== "fact" ||
			checkedOriginAttempt === undefined ||
			!checkedOriginAttempt.ok ||
			durableOriginAttempt.objectId !== input.originParentAttemptId ||
			!Number.isSafeInteger(durableOriginAttempt.revision) ||
			durableOriginAttempt.revision < 1 ||
			durableOriginAttempt.lane !== expectedOriginLane ||
			durableOriginAttempt.correlation.sessionId !== this.sessionId ||
			durableOriginAttempt.correlation.laneId !== expectedOriginLane ||
			durableOriginAttempt.correlation.taskId !== originParent.taskId ||
			durableOriginAttempt.correlation.attemptId !== input.originParentAttemptId ||
			durableOriginAttempt.correlation.agentInstanceId !== originParent.agentInstanceId ||
			durableOriginAttempt.correlation.dispatchId !== checkedOriginAttempt.value.dispatchId ||
			durableOriginAttempt.correlation.bindingId !== checkedOriginAttempt.value.bindingId ||
			checkedOriginAttempt.value.bindingEpochIds.length === 0 ||
			durableOriginAttempt.correlation.bindingEpochId !== checkedOriginAttempt.value.bindingEpochIds.at(-1) ||
			checkedOriginAttempt.value.attemptId !== input.originParentAttemptId ||
			checkedOriginAttempt.value.taskId !== originParent.taskId ||
			checkedOriginAttempt.value.agentInstanceId !== originParent.agentInstanceId ||
			!["starting", "running", "awaiting_checkpoint"].includes(checkedOriginAttempt.value.status)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent origin and lineage require durable parent identity proof"));
		}
		const bindingConcurrency = checkedBinding.value.budget.concurrency ?? this.maxConcurrent;
		const concurrencyLimit = Math.min(this.maxConcurrent, bindingConcurrency);
		if (concurrencyLimit < 1) {
			return Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent Binding forbids concurrent execution"));
		}
		const acquired = await this.acquireSlot(request.spawnId, concurrencyLimit, input.queue);
		if (!acquired.ok) return acquired;
			const createdAgent = createAgentInstance({
				agentInstanceId: input.childAgentInstanceId,
				providerId: input.providerDescriptor.descriptor.providerId,
				providerDeclaredAgent: true,
				roleRevision: request.roleRevision,
				taskId: request.taskEnvelope.taskId,
				parent: lineageParent,
				now: this.now,
			});
			if (!createdAgent.ok) return createdAgent;
			const createdEpoch = createBindingEpoch({
				bindingEpochId: input.bindingEpochId,
				taskId: request.taskEnvelope.taskId,
				attemptId: input.attemptId,
				agentInstanceId: createdAgent.value.agentInstanceId,
				bindingId: checkedBinding.value.bindingId,
				activationReason: "attempt_started",
				activatedByCommandId: input.activatedByCommandId,
				now: this.now,
			});
			if (!createdEpoch.ok) return createdEpoch;
			const dispatch: Dispatch = {
				schemaVersion: 1,
				dispatchId: input.dispatchId,
				taskId: request.taskEnvelope.taskId,
				bindingId: checkedBinding.value.bindingId,
				taskExecutorProviderId: input.providerDescriptor.descriptor.providerId,
				status: "pending",
				...(deadline.value === undefined ? {} : { deadlineAt: deadline.value }),
				createdAt: this.now(),
			};
			const checkedDispatch = validateDispatch(dispatch);
			if (!checkedDispatch.ok) return checkedDispatch;
			const correlation: ExecutionCorrelation = {
				sessionId: this.sessionId,
				laneId: input.childLaneId,
				taskId: request.taskEnvelope.taskId,
				dispatchId: dispatch.dispatchId,
				attemptId: input.attemptId,
				bindingId: checkedBinding.value.bindingId,
				bindingEpochId: createdEpoch.value.bindingEpochId,
				agentInstanceId: createdAgent.value.agentInstanceId,
				providerId: input.providerDescriptor.descriptor.providerId,
				parentId: createdAgent.value.lineage.parentId,
				ancestorIds: createdAgent.value.lineage.ancestorIds,
				revision: 0,
			};
			const record = createChildAgentRecordV1({
				schemaVersion: 1,
				childAgentInstanceId: createdAgent.value.agentInstanceId,
				parentAgentInstanceId: lineageParent.agentInstanceId,
				ancestorIds: createdAgent.value.lineage.ancestorIds ?? [],
				depth: createdAgent.value.lineage.depth,
				spawnId: request.spawnId,
				taskId: request.taskEnvelope.taskId,
				dispatchId: dispatch.dispatchId,
				attemptId: input.attemptId,
				bindingId: checkedBinding.value.bindingId,
				bindingEpochIds: [createdEpoch.value.bindingEpochId],
				providerKind: input.providerDescriptor.providerKind,
				providerId: input.providerDescriptor.descriptor.providerId,
				forkScope: request.forkScope,
				createdAt: dispatch.createdAt,
			});
			if (!record.ok) return record;
			const control: SubagentSupervisorControlV1 = {
				schemaVersion: 1,
				childAgentInstanceId: createdAgent.value.agentInstanceId,
				spawnId: request.spawnId,
				childLaneId: input.childLaneId,
				originParentAgentInstanceId: originParent.agentInstanceId,
				originParentTaskId: originParent.taskId,
				originParentAttemptId: input.originParentAttemptId,
				lineageParentAgentInstanceId: lineageParent.agentInstanceId,
				reparented: originParent.agentInstanceId !== lineageParent.agentInstanceId,
				dispatchId: dispatch.dispatchId,
				attemptId: input.attemptId,
				bindingId: checkedBinding.value.bindingId,
				bindingEpochId: createdEpoch.value.bindingEpochId,
				providerId: input.providerDescriptor.descriptor.providerId,
				maxTurns: requestedMaxTurns,
				turnCount: 0,
				recoveryRequired: false,
				resumeAllowed: false,
				resumeCount: 0,
				revision: 0,
				...(deadline.value === undefined ? {} : { deadlineAt: deadline.value }),
				updatedAt: dispatch.createdAt,
			};
			const persistedControl = await this.persistControl(control);
			if (!persistedControl.ok) return persistedControl;
			const persistedRecord = await this.persistLifecycle(record.value, 0, input.childLaneId);
			if (!persistedRecord.ok) return persistedRecord;
			return Result.ok(
				cloneDeepFrozen({
					schemaVersion: 1 as const,
					request,
					childBinding: checkedBinding.value,
					dispatch: checkedDispatch.value,
					agentInstance: createdAgent.value,
					initialBindingEpoch: createdEpoch.value,
					correlation,
					childLaneId: input.childLaneId,
					providerKind: input.providerDescriptor.providerKind,
					providerId: input.providerDescriptor.descriptor.providerId,
					maxTurns: requestedMaxTurns,
					...(deadline.value === undefined ? {} : { deadlineAt: deadline.value }),
				}),
			);
		} finally {
			this.spawnReservations.delete(request.spawnId);
			this.childReservations.delete(input.childAgentInstanceId);
			this.laneReservations.delete(input.childLaneId);
			this.slotReservations.delete(request.spawnId);
			this.drainQueue();
		}
	}

	async executeSpawn(
		plan: SubagentSpawnPlanV1,
		provider: ChildAgentProvider,
		settlement: LayeredResultSettlement,
	): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
		if (!isRecord(plan) || !exactKeys(plan, SPAWN_PLAN_KEYS) || plan.schemaVersion !== 1) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent spawn plan is invalid"));
		}
		const checkedRequest = validateChildSpawnRequest(plan.request);
		const checkedBinding = validateImmutableAgentBinding(plan.childBinding);
		const checkedDispatch = validateDispatch(plan.dispatch);
		const checkedAgent = validateAgentInstance(plan.agentInstance);
		const checkedEpoch = validateBindingEpoch(plan.initialBindingEpoch);
		const checkedCorrelation = validateExecutionCorrelation(plan.correlation);
		if (
			!checkedRequest.ok ||
			!checkedBinding.ok ||
			!checkedDispatch.ok ||
			!checkedAgent.ok ||
			!checkedEpoch.ok ||
			!checkedCorrelation.ok ||
			!isIdentifier(plan.childLaneId) ||
			!isIdentifier(plan.providerId) ||
			!isPositiveInteger(plan.maxTurns) ||
			(plan.deadlineAt !== undefined && !isCanonicalTimestamp(plan.deadlineAt))
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent spawn plan contains invalid Foundation objects"));
		}
		const record = this.records.get(plan.agentInstance.agentInstanceId);
		const control = this.controls.get(plan.agentInstance.agentInstanceId);
		if (
			record === undefined ||
			control === undefined ||
			record.status !== "spawning" ||
			provider.providerId !== plan.providerId ||
			plan.providerKind !== record.providerKind ||
			plan.maxTurns !== control.maxTurns ||
			plan.deadlineAt !== control.deadlineAt ||
			plan.request.spawnId !== control.spawnId ||
			plan.childLaneId !== control.childLaneId ||
			plan.dispatch.dispatchId !== control.dispatchId ||
			plan.initialBindingEpoch.attemptId !== control.attemptId ||
			plan.initialBindingEpoch.bindingEpochId !== control.bindingEpochId ||
			plan.childBinding.bindingId !== control.bindingId ||
			plan.agentInstance.taskId !== record.taskId ||
			plan.agentInstance.providerId !== record.providerId ||
			plan.dispatch.taskId !== record.taskId ||
			plan.dispatch.bindingId !== record.bindingId ||
			plan.dispatch.taskExecutorProviderId !== record.providerId ||
			plan.initialBindingEpoch.taskId !== record.taskId ||
			plan.initialBindingEpoch.agentInstanceId !== record.childAgentInstanceId ||
			plan.initialBindingEpoch.bindingId !== record.bindingId ||
			plan.correlation.sessionId !== this.sessionId ||
			plan.correlation.laneId !== control.childLaneId ||
			plan.correlation.taskId !== record.taskId ||
			plan.correlation.dispatchId !== record.dispatchId ||
			plan.correlation.attemptId !== record.attemptId ||
			plan.correlation.bindingId !== record.bindingId ||
			plan.correlation.bindingEpochId !== control.bindingEpochId ||
			plan.correlation.agentInstanceId !== record.childAgentInstanceId ||
			plan.correlation.providerId !== record.providerId ||
			plan.correlation.revision !== 0
		) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent spawn plan is stale or has a different provider"));
		}
		const spawned = await settlement.executeAgentSpawn({
			request: plan.request,
			provider,
			correlation: plan.correlation,
		});
		if (!spawned.ok) {
			const failed = await this.transition(record.childAgentInstanceId, "failed");
			return failed.ok ? spawned : failed;
		}
		if (!sameSpawnResultIdentity(plan, spawned.value)) {
			const lost = await this.transition(record.childAgentInstanceId, "lost");
			if (!lost.ok) return lost;
			return Result.err(new FoundationError("subagent_lost", "Child Agent spawn returned a different durable identity"));
		}
		const running = await this.transition(record.childAgentInstanceId, "running");
		return running.ok ? spawned : running;
	}

	async recordTurn(inputValue: unknown): Promise<ResultValue<number, FoundationError>> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, new Set(["schemaVersion", "childAgentInstanceId", "expectedTurnCount"])) ||
			inputValue.schemaVersion !== 1 ||
			!isIdentifier(inputValue.childAgentInstanceId) ||
			!isNonNegativeInteger(inputValue.expectedTurnCount)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent turn input is invalid"));
		}
		const recorded = await this.serial(async () => {
			const record = this.records.get(inputValue.childAgentInstanceId as string);
			const control = this.controls.get(inputValue.childAgentInstanceId as string);
			if (record === undefined || control === undefined) {
				return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
			}
			if (!ACTIVE_STATUSES.has(record.status) || record.status === "cancelling" || control.turnCount !== inputValue.expectedTurnCount) {
				return Result.err(new FoundationError("subagent_conflict", "Child Agent turn boundary is stale or terminal"));
			}
			if (control.turnCount >= control.maxTurns) {
				return Result.err(new FoundationError("subagent_max_turns_exceeded", "Child Agent max-turn limit reached"));
			}
			const nextTurnCount = control.turnCount + 1;
			const next = {
				...control,
				turnCount: nextTurnCount,
				resumeAllowed: false,
				...(nextTurnCount === control.maxTurns ? { suspensionReason: "max_turns" as const } : {}),
				revision: control.revision + 1,
				updatedAt: this.now(),
			};
			const persisted = await this.persistControl(next);
			return persisted.ok ? Result.ok(persisted.value.turnCount) : persisted;
		});
		if (!recorded.ok) return recorded;
		const control = this.controls.get(inputValue.childAgentInstanceId as string);
		if (control?.suspensionReason === "max_turns") {
			const awaiting = await this.transition(inputValue.childAgentInstanceId as string, "awaiting_input");
			if (!awaiting.ok) return awaiting;
		}
		return recorded;
	}

	async decideMaxTurns(inputValue: unknown): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const keys = new Set(["schemaVersion", "childAgentInstanceId", "expectedTurnCount", "decision", "additionalTurns"]);
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, keys) ||
			inputValue.schemaVersion !== 1 ||
			!isIdentifier(inputValue.childAgentInstanceId) ||
			!isNonNegativeInteger(inputValue.expectedTurnCount) ||
			(inputValue.decision !== "continue" && inputValue.decision !== "stop") ||
			(inputValue.decision === "continue" ? !isPositiveInteger(inputValue.additionalTurns) : inputValue.additionalTurns !== undefined)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent max-turn decision is invalid"));
		}
		const updated = await this.serial(async () => {
			const record = this.records.get(inputValue.childAgentInstanceId as string);
			const control = this.controls.get(inputValue.childAgentInstanceId as string);
			if (record === undefined || control === undefined) {
				return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
			}
			if (
				(record.status !== "awaiting_input" && record.status !== "background") ||
				control.suspensionReason !== "max_turns" ||
				control.turnCount !== inputValue.expectedTurnCount
			) {
				return Result.err(new FoundationError("subagent_conflict", "Child Agent max-turn decision is stale"));
			}
			if (inputValue.decision === "continue") {
				const nextMaxTurns = control.maxTurns + (inputValue.additionalTurns as number);
				if (nextMaxTurns > this.maxTurns) {
					return Result.err(new FoundationError("subagent_max_turns_exceeded", "Child Agent turn extension exceeds the Host limit"));
				}
				const { suspensionReason: _suspensionReason, ...withoutSuspension } = control;
				return this.persistControl({
					...withoutSuspension,
					maxTurns: nextMaxTurns,
					resumeAllowed: true,
					revision: control.revision + 1,
					updatedAt: this.now(),
				});
			}
			const { suspensionReason: _suspensionReason, ...withoutSuspension } = control;
			return this.persistControl({
				...withoutSuspension,
				resumeAllowed: false,
				revision: control.revision + 1,
				updatedAt: this.now(),
			});
		});
		if (!updated.ok) return updated;
		const current = this.records.get(inputValue.childAgentInstanceId as string);
		if (current === undefined) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent decision state was lost"));
		}
		if (inputValue.decision === "continue" && current.status === "background") return Result.ok(current);
		return this.transition(
			inputValue.childAgentInstanceId as string,
			inputValue.decision === "continue" ? "background" : "cancelling",
		);
	}

	async markAwaitingInput(childAgentInstanceId: string): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		return this.transition(childAgentInstanceId, "awaiting_input");
	}

	async markBackground(childAgentInstanceId: string): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		return this.transition(childAgentInstanceId, "background");
	}

	async cancel(
		childAgentInstanceId: string,
		provider: Pick<ChildAgentProvider, "providerId" | "cancel">,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const record = this.records.get(childAgentInstanceId);
		if (record === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		if (isChildExecutionTerminalStatusV1(record.status) || record.status === "closed") return Result.ok(record);
		if (provider.providerId !== record.providerId) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent cancel provider does not match"));
		}
		const spawning = record.status === "spawning";
		if (!spawning && record.status !== "cancelling") {
			const transition = await this.transition(childAgentInstanceId, "cancelling");
			if (!transition.ok) return transition;
		}
		try {
			const cancelled = await provider.cancel(record.attemptId);
			if (cancelled.ok) {
				if (spawning) return this.transition(childAgentInstanceId, "failed");
				const cancelling = this.records.get(childAgentInstanceId);
				return cancelling === undefined
					? Result.err(new FoundationError("subagent_persistence_failed", "Child Agent cancelling state was lost"))
					: Result.ok(cancelling);
			}
			const lost = await this.transition(childAgentInstanceId, "lost");
			if (!lost.ok) return lost;
			return Result.err(new FoundationError("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
		} catch {
			const lost = await this.transition(childAgentInstanceId, "lost");
			if (!lost.ok) return lost;
			return Result.err(new FoundationError("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
		}
	}

	async enforceDeadline(
		childAgentInstanceId: string,
		provider: Pick<ChildAgentProvider, "providerId" | "cancel">,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const control = this.controls.get(childAgentInstanceId);
		if (control === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		if (control.deadlineAt === undefined || this.now() < control.deadlineAt) {
			const record = this.records.get(childAgentInstanceId);
			return record === undefined
				? Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"))
				: Result.ok(record);
		}
		return this.cancel(childAgentInstanceId, provider);
	}

	async settleReceipt(
		childAgentInstanceId: string,
		receiptValue: unknown,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const record = this.records.get(childAgentInstanceId);
		if (record === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		const receipt = validateAttemptReceipt(receiptValue, { providerClass: "agent" });
		if (!receipt.ok) return this.rejectUntrustedReceipt(record, receipt.error);
		const control = this.controls.get(childAgentInstanceId);
		if (control === undefined) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent receipt control is missing"));
		}
		const receiptCorrelation = receipt.value.provenance.correlation;
		if (
			receipt.value.agentInstanceId !== record.childAgentInstanceId ||
			receipt.value.attemptId !== record.attemptId ||
			receipt.value.dispatchId !== record.dispatchId ||
			receipt.value.taskId !== record.taskId ||
			receipt.value.bindingId !== record.bindingId ||
			receipt.value.providerId !== record.providerId ||
			canonicalFoundationJson(receipt.value.bindingEpochIds) !== canonicalFoundationJson(record.bindingEpochIds) ||
			receiptCorrelation?.sessionId !== this.sessionId ||
			receiptCorrelation.laneId !== control.childLaneId ||
			receiptCorrelation.agentInstanceId !== record.childAgentInstanceId
		) {
			return this.rejectUntrustedReceipt(
				record,
				new FoundationError("subagent_conflict", "Child Agent receipt identity does not match"),
			);
		}
		let durableReceipt: Awaited<ReturnType<SessionLedger["get"]>>;
		try {
			durableReceipt = await this.ledger.get("attempt_receipt", receipt.value.attemptReceiptId);
		} catch {
			return this.rejectUntrustedReceipt(
				record,
				new FoundationError("subagent_persistence_failed", "Durable Child Agent receipt could not be read"),
			);
		}
		const durableReceiptMismatch =
			durableReceipt?.kind !== "fact" ||
			durableReceipt.objectId !== receipt.value.attemptReceiptId ||
			durableReceipt.revision !== 1 ||
			durableReceipt.correlation.sessionId !== this.sessionId ||
			durableReceipt.correlation.laneId !== control.childLaneId ||
			durableReceipt.correlation.taskId !== record.taskId ||
			durableReceipt.correlation.dispatchId !== record.dispatchId ||
			durableReceipt.correlation.attemptId !== record.attemptId ||
			durableReceipt.correlation.bindingId !== record.bindingId ||
			durableReceipt.correlation.bindingEpochId !== receiptCorrelation?.bindingEpochId ||
			durableReceipt.correlation.attemptReceiptId !== receipt.value.attemptReceiptId ||
			durableReceipt.correlation.agentInstanceId !== record.childAgentInstanceId ||
			canonicalFoundationJson(durableReceipt.payload) !== canonicalFoundationJson(receipt.value);
		if (
			(receipt.value.status !== "suspended" && durableReceiptMismatch) ||
			(receipt.value.status === "suspended" && durableReceipt !== undefined && durableReceiptMismatch)
		) {
			return this.rejectUntrustedReceipt(
				record,
				new FoundationError("subagent_conflict", "Child Agent receipt is missing or differs from its immutable durable fact"),
			);
		}
		if (receipt.value.status === "cancelled" && receipt.value.sideEffectState !== "none") {
			return this.rejectUntrustedReceipt(
				record,
				new FoundationError("side_effect_unknown", "Cancelled Child Agent must prove safe stop"),
			);
		}
		if (receipt.value.status === "suspended") {
			const persisted = await this.persistControl({
				...control,
				recoveryRequired: false,
				resumeAllowed: false,
				suspensionReason: "max_turns",
				revision: control.revision + 1,
				updatedAt: this.now(),
			});
			if (!persisted.ok) return persisted;
			if (record.status === "awaiting_input") {
				return Result.ok(this.records.get(childAgentInstanceId) ?? record);
			}
			const awaiting = await this.transition(childAgentInstanceId, "awaiting_input");
			return awaiting.ok
				? awaiting
				: awaiting.error.code === "subagent_conflict"
					? this.rejectUntrustedReceipt(record, awaiting.error)
					: awaiting;
		}
		return this.transition(childAgentInstanceId, receipt.value.status, receipt.value.attemptReceiptId);
	}

	async markLost(childAgentInstanceId: string): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		return this.transition(childAgentInstanceId, "lost");
	}

	async resume(
		childAgentInstanceId: string,
		provider: Pick<ChildAgentProvider, "providerId" | "resume" | "lookupSpawn">,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const record = this.records.get(childAgentInstanceId);
		const control = this.controls.get(childAgentInstanceId);
		if (record === undefined || control === undefined) {
			return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		}
		if (
			provider.providerId !== record.providerId ||
			record.status === "closed" ||
			record.status === "cancelling" ||
			isChildExecutionTerminalStatusV1(record.status)
		) {
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent cannot resume from its current identity or status"));
		}
		if (!control.recoveryRequired && !control.resumeAllowed) {
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent resume requires durable recovery or a parent continuation decision"));
		}
		if (control.suspensionReason === "max_turns" && !control.resumeAllowed) {
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent suspension requires a parent decision"));
		}
		try {
			if (record.status === "spawning") {
				if (provider.lookupSpawn === undefined) {
					const lost = await this.transition(childAgentInstanceId, "lost");
					if (!lost.ok) return lost;
					return Result.err(new FoundationError("subagent_resume_failed", "Child Agent spawn lookup is unavailable"));
				}
				const lookup = await provider.lookupSpawn(record.spawnId);
				if (!lookup.ok || lookup.value === undefined) {
					const lost = await this.transition(childAgentInstanceId, "lost");
					if (!lost.ok) return lost;
					return Result.err(new FoundationError("subagent_resume_failed", "Child Agent spawn could not be recovered"));
				}
				if (
					lookup.value.agentInstance.agentInstanceId !== record.childAgentInstanceId ||
					lookup.value.attempt.attemptId !== record.attemptId
				) {
					const lost = await this.transition(childAgentInstanceId, "lost");
					if (!lost.ok) return lost;
					return Result.err(new FoundationError("subagent_lost", "Recovered Child Agent identity does not match"));
				}
				const running = await this.transition(childAgentInstanceId, "running");
				if (!running.ok) return running;
			}
			if (record.status === "awaiting_input") {
				const background = await this.transition(childAgentInstanceId, "background");
				if (!background.ok) return background;
			}
			const resumed = await provider.resume(record.attemptId);
			if (!resumed.ok) {
				const lost = await this.transition(childAgentInstanceId, "lost");
				if (!lost.ok) return lost;
				return Result.err(new FoundationError("subagent_resume_failed", "Child Agent transcript could not be resumed"));
			}
			const settled = await this.settleReceipt(childAgentInstanceId, resumed.value);
			if (!settled.ok) {
				const latest = this.records.get(childAgentInstanceId);
				if (latest !== undefined && latest.status !== "lost") {
					const lost = await this.transition(childAgentInstanceId, "lost");
					if (!lost.ok) return lost;
				}
				return Result.err(new FoundationError("subagent_resume_failed", "Child Agent resumed receipt was invalid"));
			}
			const latestControl = this.controls.get(childAgentInstanceId);
			if (latestControl === undefined) {
				return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent recovery control is missing"));
			}
			const persisted = await this.persistControl({
				...latestControl,
				recoveryRequired: false,
				resumeAllowed: false,
				resumeCount: latestControl.resumeCount + 1,
				revision: latestControl.revision + 1,
				updatedAt: this.now(),
			});
			return persisted.ok ? settled : persisted;
		} catch {
			const lost = await this.transition(childAgentInstanceId, "lost");
			if (!lost.ok) return lost;
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent transcript could not be resumed"));
		}
	}

	async close(
		childAgentInstanceId: string,
		cleanupConfirmed: boolean,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const record = this.records.get(childAgentInstanceId);
		if (record === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		if (!cleanupConfirmed) {
			return Result.err(new FoundationError("subagent_close_unknown", "Child Agent resource closure is unknown"));
		}
		if (record.status === "closed") return Result.ok(record);
		if (!isChildExecutionTerminalStatusV1(record.status)) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent must reach an execution terminal before close"));
		}
		return this.transition(childAgentInstanceId, "closed");
	}

	async forceClose(
		childAgentInstanceId: string,
		cleanupConfirmed: boolean,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		const record = this.records.get(childAgentInstanceId);
		if (record === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		if (!isChildExecutionTerminalStatusV1(record.status) && record.status !== "closed") {
			const lost = await this.transition(childAgentInstanceId, "lost");
			if (!lost.ok) return lost;
		}
		return this.close(childAgentInstanceId, cleanupConfirmed);
	}

	get(childAgentInstanceId: string): ChildAgentRecordV1 | undefined {
		const record = this.records.get(childAgentInstanceId);
		return record === undefined ? undefined : cloneDeepFrozen(record);
	}

	providerSpawnPlan(inputValue: unknown): ResultValue<SubagentProviderSpawnPlanV1, FoundationError> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, new Set(["schemaVersion", "spawnId"])) ||
			inputValue.schemaVersion !== 1 ||
			!isIdentifier(inputValue.spawnId)
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Provider spawn-plan lookup is invalid"));
		}
		const control = [...this.controls.values()].find((candidate) => candidate.spawnId === inputValue.spawnId);
		if (control === undefined) return Result.err(new FoundationError("subagent_not_found", "Provider spawn plan was not found"));
		return Result.ok(
			cloneDeepFrozen({
				schemaVersion: 1 as const,
				spawnId: control.spawnId,
				childLaneId: control.childLaneId,
				childAgentInstanceId: control.childAgentInstanceId,
				dispatchId: control.dispatchId,
				attemptId: control.attemptId,
				bindingId: control.bindingId,
				bindingEpochId: control.bindingEpochId,
				providerId: control.providerId,
			}),
		);
	}

	list(): readonly ChildAgentRecordV1[] {
		return Object.freeze(
			[...this.records.values()]
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.childAgentInstanceId.localeCompare(right.childAgentInstanceId))
				.map((record) => cloneDeepFrozen(record)),
		);
	}

	roster(): readonly ChildAgentRosterEntryV1[] {
		return Object.freeze(
			this.list().map((record) => {
				const control = this.controls.get(record.childAgentInstanceId);
				if (control === undefined) throw new FoundationError("subagent_persistence_failed", "Child Agent control is missing");
				return cloneDeepFrozen({
					schemaVersion: 1 as const,
					sessionId: this.sessionId,
					laneId: control.childLaneId,
					childAgentInstanceId: record.childAgentInstanceId,
					parentAgentInstanceId: record.parentAgentInstanceId,
					ancestorIds: record.ancestorIds,
					depth: record.depth,
					taskId: record.taskId,
					attemptId: record.attemptId,
					providerId: record.providerId,
					providerKind: record.providerKind,
					status: record.status,
					mailboxAddress: record.childAgentInstanceId,
				});
			}),
		);
	}

	private async rejectUntrustedReceipt(
		record: ChildAgentRecordV1,
		error: FoundationError,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		if (record.status === "closed" || isChildExecutionTerminalStatusV1(record.status)) return Result.err(error);
		const lost = await this.transition(record.childAgentInstanceId, "lost");
		return lost.ok ? Result.err(error) : lost;
	}

	private async transition(
		childAgentInstanceId: string,
		to: ChildLifecycleStatusV1,
		attemptReceiptId?: string,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		return this.serial(async () => {
			const current = this.records.get(childAgentInstanceId);
			if (current === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
			const transitioned = transitionChildAgentRecordV1(current, {
				schemaVersion: 1,
				childAgentInstanceId: current.childAgentInstanceId,
				parentAgentInstanceId: current.parentAgentInstanceId,
				spawnId: current.spawnId,
				expectedRevision: current.revision,
				to,
				at: this.now(),
				...(attemptReceiptId === undefined ? {} : { attemptReceiptId }),
			});
			if (!transitioned.ok) return transitioned;
			if (transitioned.value.idempotent) return Result.ok(transitioned.value.record);
			const persisted = await this.persistLifecycle(transitioned.value.record, transitioned.value.record.revision);
			if (persisted.ok && (isChildExecutionTerminalStatusV1(to) || to === "closed")) this.drainQueue();
			return persisted;
		});
	}

	private async persistLifecycle(
		record: ChildAgentRecordV1,
		expectedRevision: number,
		childLaneId = this.controls.get(record.childAgentInstanceId)?.childLaneId,
	): Promise<ResultValue<ChildAgentRecordV1, FoundationError>> {
		if (!validateEventPayloadForCategory("subagent.lifecycle_transitioned", record)) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent lifecycle event is invalid"));
		}
		if (childLaneId === undefined) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent durable lane is missing"));
		}
		try {
			const stored = await this.ledgerForLane(childLaneId).appendFact(
				SUBAGENT_LIFECYCLE_OBJECT_TYPE,
				record.childAgentInstanceId,
				record,
				{
					clientRequestId: `subagent-lifecycle:${record.childAgentInstanceId}:${record.revision}`,
					expectedRevision,
					correlation: {
						taskId: record.taskId,
						dispatchId: record.dispatchId,
						attemptId: record.attemptId,
						bindingId: record.bindingId,
						bindingEpochId: record.bindingEpochIds.at(-1),
						agentInstanceId: record.childAgentInstanceId,
						parentId: record.parentAgentInstanceId,
						ancestorIds: record.ancestorIds,
					},
				},
			);
			if (
				!validateChildAgentRecordV1(stored.payload) ||
				stored.record.correlation.sessionId !== this.sessionId ||
				stored.record.correlation.laneId !== childLaneId ||
				stored.record.correlation.agentInstanceId !== record.childAgentInstanceId
			) {
				return Result.err(new FoundationError("subagent_persistence_failed", "Persisted Child Agent lifecycle is invalid"));
			}
			this.records.set(record.childAgentInstanceId, cloneDeepFrozen(stored.payload));
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent lifecycle could not be persisted"));
		}
	}

	private async persistControl(
		control: SubagentSupervisorControlV1,
	): Promise<ResultValue<SubagentSupervisorControlV1, FoundationError>> {
		if (!validateControl(control)) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent control is invalid"));
		}
		try {
			const stored = await this.ledger.appendFact(
				SUBAGENT_SUPERVISOR_CONTROL_OBJECT_TYPE,
				control.childAgentInstanceId,
				control,
				{
					clientRequestId: `subagent-control:${control.childAgentInstanceId}:${control.revision}`,
					expectedRevision: control.revision,
					correlation: { agentInstanceId: control.childAgentInstanceId },
				},
			);
			if (
				!validateControl(stored.payload) ||
				stored.record.correlation.sessionId !== this.sessionId ||
				stored.record.correlation.laneId !== this.laneId ||
				stored.record.correlation.agentInstanceId !== control.childAgentInstanceId
			) {
				return Result.err(new FoundationError("subagent_persistence_failed", "Persisted Child Agent control is invalid"));
			}
			this.controls.set(control.childAgentInstanceId, cloneDeepFrozen(stored.payload));
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent control could not be persisted"));
		}
	}

	private activeCount(): number {
		return [...this.records.values()].filter((record) => ACTIVE_STATUSES.has(record.status)).length + this.slotReservations.size;
	}

	private acquireSlot(
		spawnId: string,
		concurrencyLimit: number,
		policy: SubagentQueuePolicyV1,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.activeCount() < concurrencyLimit && this.queue.length === 0) {
			this.slotReservations.add(spawnId);
			return Promise.resolve(Result.ok(undefined));
		}
		if (policy.mode === "fail") {
			return Promise.resolve(Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent concurrency limit exceeded")));
		}
		const timeoutMs = policy.timeoutMs;
		if (timeoutMs === undefined || timeoutMs > this.maximumQueueWaitMs || this.queue.length >= this.queueCapacity) {
			return Promise.resolve(Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent queue is full or its wait is invalid")));
		}
		return new Promise((resolve) => {
			let active = true;
			const onTimeout = (): void => {
				if (!active) return;
				active = false;
				const index = this.queue.findIndex((waiter) => waiter.spawnId === spawnId);
				if (index >= 0) this.queue.splice(index, 1);
				resolve(Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent queue wait expired")));
				this.drainQueue();
			};
			let cancelScheduled: () => void;
			try {
				cancelScheduled = this.scheduleQueueTimeout(timeoutMs, onTimeout);
				if (typeof cancelScheduled !== "function") {
					resolve(Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent queue scheduler is invalid")));
					return;
				}
			} catch {
				resolve(Result.err(new FoundationError("subagent_concurrency_exceeded", "Child Agent queue wait could not be scheduled")));
				return;
			}
			const cancelTimeout = (): void => {
				if (!active) return;
				active = false;
				cancelScheduled();
			};
			if (!active) {
				cancelScheduled();
				return;
			}
			this.queue.push({ spawnId, concurrencyLimit, resolve, cancelTimeout });
		});
	}

	private drainQueue(): void {
		while (this.queue.length > 0) {
			const waiter = this.queue[0]!;
			if (this.activeCount() >= waiter.concurrencyLimit) return;
			this.queue.shift();
			waiter.cancelTimeout();
			this.slotReservations.add(waiter.spawnId);
			waiter.resolve(Result.ok(undefined));
		}
	}

	private serial<T>(operation: () => Promise<ResultValue<T, FoundationError>>): Promise<ResultValue<T, FoundationError>> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}
}
