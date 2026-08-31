import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	AgentHarnessChildAgentEntryRuntime,
	runChildAgentProcess,
	type ChildAgentEntryRuntime,
} from "../../src/child-agent-entry.ts";
import {
	createAgentInstance,
	createContextSnapshot,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	LayeredResultSettlement,
	resolveAgentBinding,
	FoundationError,
	Result,
	Session,
	SessionLedger,
	SessionLedgerWriter,
	validateAttemptReceiptForProvider,
	type AgentBinding,
	type AgentInstance,
	type AttemptReceipt,
	type BudgetUsage,
	type Budget,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type Dispatch,
	type FoundationProviderCapability,
	type HarnessTool,
	type ModelProfile,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	type RevisionReference,
	type RoleRevision,
	type TaskEnvelope,
} from "../../../agent/src/internal.ts";
import { createAssistantMessageEventStream, createModels, fakeProvider } from "@aos-agent/ai";
import { describe, expect, it } from "vitest";
import type { SubagentProviderDescriptor } from "../../src/core/subagent/registry.ts";
import {
	CHILD_BINDING_PROJECTION_FIELDS,
	CHILD_BINDING_PROJECTION_OBJECT_TYPE,
} from "../../src/core/subagent/binding.ts";
import {
	CHILD_AGENT_PROTOCOL_FEATURES,
	CHILD_AGENT_PROTOCOL_VERSION,
	parseChildAgentFrame,
	serializeChildAgentFrameLine,
	type ChildAgentInitializeRequest,
	type ChildAgentRequestFrame,
} from "../../src/core/subagent/fork-protocol.ts";
import {
	ForkChildAgentProvider,
	type ChildAgentProcess,
	type ChildAgentProcessSpawnSpec,
} from "../../src/core/subagent/fork-provider.ts";
import {
	SubagentSupervisor,
	type PlanSubagentSpawnInput,
	type SubagentSpawnPlan,
} from "../../src/core/subagent/supervisor.ts";
import type { LoadParentContext } from "../../src/core/subagent/provider-context.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROVIDER_ID = "native.fork";
const ENTRYPOINT = fileURLToPath(import.meta.url);
const REAL_ENTRYPOINT = fileURLToPath(new URL("fixtures/fake-child-agent-entry.ts", import.meta.url));
const ROOT_TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));
const RUN_REAL_FORK_SMOKE = process.env.AOS_AGENT_REAL_FORK_SMOKE === "1";
const CHILD_AGENT_ENTRY_SENTINEL = "AOS_CHILD_AGENT_FORK_OK";
const CHILD_AGENT_PARENT_CONTEXT = "AOS_CHILD_AGENT_PARENT_CONTEXT";
const TSX_IMPORT = import.meta.resolve("tsx");

function task(taskId: string, concurrency = 2): TaskEnvelope {
	const result = createTaskEnvelope({
		schemaVersion: 1,
		taskId,
		goalId: "goal-1",
		goal: `run ${taskId}`,
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 1000, concurrency },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function role(): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-child",
			scope: "project",
			slug: "child",
			name: "Child",
			description: "Child role",
			revision: 1,
			persona: "Run the child task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-child", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function profile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile-child",
		provider: "fake",
		model: "model-1",
		budget: { tokens: 1000, concurrency: 2 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(taskEnvelope: TaskEnvelope, roleRevision: RoleRevision, modelProfile: ModelProfile): AgentBinding {
	const result = resolveAgentBinding({
		task: taskEnvelope,
		roleRevision,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "context-1"),
		capabilityRevision: immutableFact("capability_binding", "capability-1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-1"),
		policyRevision: immutableFact("policy_binding", "policy-1"),
		newBindingId: `binding-${taskEnvelope.taskId}`,
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function rootAgent(agentInstanceId: string, taskId: string, roleRevision: RoleRevision): AgentInstance {
	const result = createAgentInstance({
		agentInstanceId,
		providerId: "parent-provider",
		providerDeclaredAgent: true,
		roleRevision,
		taskId,
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

const descriptor: SubagentProviderDescriptor = {
	schemaVersion: 1,
	providerKind: "fork",
	descriptor: { schemaVersion: 1, providerId: PROVIDER_ID, providerClass: "agent" },
	revision: 1,
	capabilities: {
		resumeSupported: true,
		mailboxSupported: true,
		backgroundSupported: true,
		worktreeSupported: true,
		maxDepth: 5,
	},
	implementedInThisLine: true,
};

class RecordingQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota-test";
	readonly providerClass = "quota" as const;
	readonly reservations: QuotaReservation[] = [];
	readonly settlements: { readonly reservation: QuotaReservation; readonly usage: BudgetUsage }[] = [];

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "quota.test", version: 1 }];
	}

	async reserve(attribution: QuotaAttribution, budget: Budget) {
		const reservation: QuotaReservation = {
			schemaVersion: 1,
			reservationId: `reservation-${this.reservations.length + 1}`,
			attribution,
			budget,
			grantedAt: NOW,
		};
		this.reservations.push(reservation);
		return Result.ok(reservation);
	}

	async settle(reservation: QuotaReservation, usage: BudgetUsage) {
		this.settlements.push({ reservation, usage });
		return Result.ok(usage);
	}

	async dispose() {}
}

type FakeMode =
	| "ok"
	| "malformed"
	| "invalid-receipt"
	| "disconnect"
	| "exit"
	| "hang-cancel"
	| "hang-turn"
	| "hang-close"
	| "closed-without-exit"
	| "mismatched-closed"
	| "cancel-receipt-only"
	| "cancel-succeeded"
	| "cancel-write-failure";

class FakeChild extends EventEmitter implements ChildAgentProcess {
	readonly stdin: PassThrough;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly mode: FakeMode;
	readonly pid: number;
	killed = false;
	initialize: ChildAgentInitializeRequest | undefined;
	lastParseError: string | undefined;
	turnRequestId: string | undefined;
	cancelReceived = false;
	closeReceived = false;
	private buffer = "";

	constructor(mode: FakeMode, pid: number) {
		super();
		this.mode = mode;
		this.pid = pid;
		const stdin = new PassThrough();
		const consume = (chunk: string | Buffer): void => {
			this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline + 1);
				this.buffer = this.buffer.slice(newline + 1);
				this.handleLine(line);
				newline = this.buffer.indexOf("\n");
			}
		};
		stdin.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
			if (this.mode === "cancel-write-failure" && chunk.toString().includes('"type":"cancel"')) {
				throw new Error("cancel pipe write failed");
			}
			consume(chunk);
			if (typeof encoding === "function") encoding();
			else if (callback !== undefined) callback();
			return true;
		}) as typeof stdin.write;
		stdin.on("data", consume);
		this.stdin = stdin;
	}

	kill(): boolean {
		this.killed = true;
		if (this.mode !== "cancel-write-failure") this.emit("exit", 1, null);
		return true;
	}

	emitLine(line: string): void {
		this.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
	}

	private handleLine(line: string): void {
		const parsed = parseChildAgentFrame(line);
		if (!parsed.ok) {
			this.lastParseError = parsed.error.message;
			return;
		}
		if (
			parsed.value.type !== "initialize" &&
			parsed.value.type !== "turn" &&
			parsed.value.type !== "cancel" &&
			parsed.value.type !== "close"
		) {
			return;
		}
		try {
			this.dispatchFrame(parsed.value);
		} catch (error) {
			this.lastParseError = error instanceof Error ? error.message : String(error);
		}
	}

	private dispatchFrame(frame: ChildAgentRequestFrame): void {
		if (frame.type === "initialize") {
			this.initialize = frame as ChildAgentInitializeRequest;
			if (this.mode === "exit") {
				this.emit("exit", 1, null);
				return;
			}
			if (this.mode === "malformed") {
				this.emitLine("not-json");
				return;
			}
			if (this.mode === "disconnect") {
				this.stdout.end();
				return;
			}
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "ready",
					requestId: frame.requestId,
					spawnId: frame.spawnId,
					protocolVersion: CHILD_AGENT_PROTOCOL_VERSION,
					features: CHILD_AGENT_PROTOCOL_FEATURES,
					providerId: this.initialize.providerId,
					agentInstanceId: this.initialize.agentInstanceId,
				}),
			);
			return;
		}
		if (frame.type === "turn") {
			this.turnRequestId = frame.requestId;
			if (this.mode === "hang-cancel") return;
			if (this.initialize === undefined || frame.attemptId === undefined) return;
			const requestId = frame.requestId;
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "turn.started",
					requestId,
					spawnId: frame.spawnId,
					attemptId: frame.attemptId,
					at: NOW,
				}),
			);
			if (
				this.mode === "hang-turn" ||
				this.mode === "cancel-receipt-only" ||
				this.mode === "cancel-succeeded" ||
				this.mode === "cancel-write-failure"
			) return;
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "turn.completed",
					requestId,
					spawnId: frame.spawnId,
					attemptId: frame.attemptId,
					stopReason: "stop",
					usage: { tokens: 3, modelCalls: 1, toolCalls: 1 },
					at: NOW,
				}),
			);
			if (this.mode === "invalid-receipt") {
				this.stdout.write(`${JSON.stringify({ type: "receipt", requestId, receipt: this.receipt(true) })}\n`);
				return;
			}
			this.emitLine(serializeChildAgentFrameLine({ type: "receipt", requestId, receipt: this.receipt(false) }));
		}
		if (frame.type === "cancel") {
			this.cancelReceived = true;
			if (this.mode === "hang-cancel" || this.initialize === undefined) return;
			const requestId = this.turnRequestId ?? this.initialize.requestId;
			if (this.mode === "cancel-succeeded") {
				this.emitLine(
					serializeChildAgentFrameLine({
						type: "turn.completed",
						requestId,
						spawnId: frame.spawnId,
						attemptId: frame.attemptId,
						stopReason: "stop",
						usage: { tokens: 3, modelCalls: 1, toolCalls: 1 },
						at: NOW,
					}),
				);
				this.emitLine(serializeChildAgentFrameLine({ type: "receipt", requestId, receipt: this.receipt(false) }));
				return;
			}
			if (this.mode === "cancel-receipt-only") {
				this.emitLine(
					serializeChildAgentFrameLine({
						type: "receipt",
						requestId,
						receipt: this.cancelledReceipt(),
					}),
				);
				return;
			}
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "turn.completed",
					requestId,
					spawnId: frame.spawnId,
					attemptId: frame.attemptId,
					stopReason: "aborted",
					usage: { tokens: 3, modelCalls: 1, toolCalls: 1 },
					at: NOW,
				}),
			);
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "receipt",
					requestId,
					receipt: this.cancelledReceipt(),
				}),
			);
		}
		if (frame.type === "close") {
			this.closeReceived = true;
			if (this.mode === "hang-close") return;
			this.emitLine(
				serializeChildAgentFrameLine({
					type: "closed",
					requestId: this.mode === "mismatched-closed" ? `${frame.requestId}-other` : frame.requestId,
					spawnId: frame.spawnId,
				}),
			);
			if (this.mode === "closed-without-exit") return;
			this.emit("exit", 0, null);
			this.stdout.end();
		}
	}

	private receipt(invalid: boolean): AttemptReceipt {
		const init = this.initialize!;
		const attemptReceiptId = `attempt-receipt:${init.attemptId}`;
		if (invalid) {
			return {
				schemaVersion: 1,
				attemptReceiptId,
				taskId: init.taskId,
				dispatchId: init.dispatchId,
				attemptId: init.attemptId,
				providerId: init.providerId,
				bindingId: init.bindingId,
				bindingEpochIds: [init.bindingEpochId],
				status: "succeeded",
				workerReceiptRefs: [],
				artifacts: [],
				provenance: {
					producerKind: "scheduler",
					providerId: init.providerId,
					producedAt: NOW,
					correlation: { ...init.correlation, attemptReceiptId },
				},
				sideEffectState: "none",
			};
		}
		return {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: init.taskId,
			dispatchId: init.dispatchId,
			attemptId: init.attemptId,
			providerId: init.providerId,
			agentInstanceId: init.agentInstanceId,
			bindingId: init.bindingId,
			bindingEpochIds: [init.bindingEpochId],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "agent_executor",
				providerId: init.providerId,
				producedAt: NOW,
				correlation: { ...init.correlation, attemptReceiptId },
			},
			sideEffectState: "none",
		};
	}

	private cancelledReceipt(): AttemptReceipt {
		const base = this.receipt(false);
		return { ...base, status: "cancelled" };
	}
}

interface Fixture {
	readonly session: Session;
	readonly ledger: SessionLedger;
	readonly ledgerForLane: (laneId: string) => SessionLedger;
	readonly supervisor: SubagentSupervisor;
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
}

function fixture(): Fixture {
	const session = new Session(new InMemorySessionStorage({ id: "session-fork", createdAt: 1 }));
	const ledgers = new Map<string, SessionLedger>();
	const ledgerForLane = (laneId: string): SessionLedger => {
		let selected = ledgers.get(laneId);
		if (selected === undefined) {
			selected = new SessionLedger(session, { ownerId: "supervisor-writer", laneId });
			ledgers.set(laneId, selected);
		}
		return selected;
	};
	const ledger = ledgerForLane("control-lane");
	return {
		session,
		ledger,
		ledgerForLane,
		supervisor: new SubagentSupervisor({
			schemaVersion: 1,
			ledger,
			ledgerForLane,
			sessionId: "session-fork",
			laneId: "control-lane",
			maxDepth: 4,
			maxConcurrent: 2,
			maxTurns: 4,
			queueCapacity: 2,
			maximumQueueWaitMs: 100,
			now: () => NOW,
		}),
		roleRevision: role(),
		modelProfile: profile(),
	};
}

async function planInput(value: Fixture, overrides: Partial<PlanSubagentSpawnInput> = {}): Promise<PlanSubagentSpawnInput> {
	const origin = overrides.originParentAgentInstance ?? rootAgent("parent-1", "task-parent", value.roleRevision);
	const lineageParent = overrides.lineageParentAgentInstance ?? origin;
	const childTask = overrides.request?.taskEnvelope ?? task(`task-child-${overrides.childAgentInstanceId ?? "1"}`);
	const childBinding = overrides.childBinding ?? binding(childTask, value.roleRevision, value.modelProfile);
	const seed = async (
		objectType: string,
		objectId: string,
		payload: object,
		correlation: {
			readonly taskId?: string;
			readonly dispatchId?: string;
			readonly attemptId?: string;
			readonly bindingId?: string;
			readonly bindingEpochId?: string;
			readonly agentInstanceId?: string;
		} = {},
	): Promise<void> => {
		if ((await value.ledger.get(objectType, objectId)) !== undefined) return;
		await value.ledger.appendFact(objectType, objectId, payload, {
			clientRequestId: `seed:${objectType}:${objectId}`,
			expectedRevision: 0,
			correlation: { taskId: childTask.taskId, bindingId: childBinding.bindingId, ...correlation },
		});
	};
	await seed("task", childTask.taskId, childTask);
	await seed("role_revision", childBinding.roleRevision.id, value.roleRevision);
	await seed("model_profile_revision", childBinding.modelProfileRevision.id, value.modelProfile);
	for (const [objectType, reference] of [
		["external_agent_binding", childBinding.contextRevision],
		["capability_binding", childBinding.capabilityRevision],
		["model_broker_binding", childBinding.modelBrokerBindingRevision],
		["policy_binding", childBinding.policyRevision],
	] as const) {
		await seed(objectType, reference.id, {
			schemaVersion: 1,
			type: reference.type,
			id: reference.id,
			revision: reference.revision,
		});
	}
	const spawnId = overrides.request?.spawnId ?? `spawn-${overrides.childAgentInstanceId ?? "1"}`;
	await seed("agent_binding", childBinding.bindingId, childBinding);
	const projectionFields = CHILD_BINDING_PROJECTION_FIELDS.map((field) => ({
		field,
		parentDigest: fingerprintFoundationValue({ field, side: "shared" }),
		childDigest: fingerprintFoundationValue({ field, side: "shared" }),
		tighteningProof: "equal" as const,
	}));
	const projectionBase = {
		schemaVersion: 1 as const,
		parentBindingId: `binding-${origin.taskId}`,
		childBindingId: childBinding.bindingId,
		spawnId,
		fields: projectionFields,
		createdAt: NOW,
	};
	await seed(CHILD_BINDING_PROJECTION_OBJECT_TYPE, spawnId, {
		...projectionBase,
		digest: fingerprintFoundationValue(projectionBase),
	});
	await seed("agent_instance", origin.agentInstanceId, origin, {
		taskId: origin.taskId,
		agentInstanceId: origin.agentInstanceId,
	});
	await seed("agent_instance", lineageParent.agentInstanceId, lineageParent, {
		taskId: lineageParent.taskId,
		agentInstanceId: lineageParent.agentInstanceId,
	});
	const originAttemptId = overrides.originParentAttemptId ?? "attempt-parent";
	if ((await value.ledger.get("attempt", originAttemptId)) === undefined) {
		await value.ledger.appendFact(
			"attempt",
			originAttemptId,
			{
				schemaVersion: 1,
				attemptId: originAttemptId,
				dispatchId: `dispatch-${originAttemptId}`,
				taskId: origin.taskId,
				providerId: origin.providerId,
				agentInstanceId: origin.agentInstanceId,
				bindingId: `binding-${origin.taskId}`,
				bindingEpochIds: [`epoch-${originAttemptId}`],
				status: "running",
				startedAt: NOW,
			},
			{
				clientRequestId: `seed:attempt:${originAttemptId}`,
				expectedRevision: 0,
				correlation: {
					taskId: origin.taskId,
					dispatchId: `dispatch-${originAttemptId}`,
					attemptId: originAttemptId,
					bindingId: `binding-${origin.taskId}`,
					bindingEpochId: `epoch-${originAttemptId}`,
					agentInstanceId: origin.agentInstanceId,
				},
			},
		);
	}
	const parentSpawnId = `parent-${spawnId}`;
	const request: ChildSpawnRequest = overrides.request ?? {
		schemaVersion: 1,
		spawnId,
		parentSpawn: {
			schemaVersion: 1,
			type: "agent.spawn",
			spawnId: parentSpawnId,
			parentTaskId: origin.taskId,
			newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTask.taskId, revision: 1 },
			providerId: PROVIDER_ID,
			createdAt: NOW,
		},
		taskEnvelope: childTask,
		roleRevision: value.roleRevision,
		modelProfile: value.modelProfile,
		parentAttemptId: originAttemptId,
		parentAgentInstanceId: lineageParent.agentInstanceId,
		forkScope: "none",
	};
	await seed("task", origin.taskId, task(origin.taskId));
	if (request.parentSpawn !== undefined) {
		const parentContextId = `context_${request.parentSpawn.spawnId}`;
		await seed("context", parentContextId, {
			schemaVersion: 1,
			contextId: parentContextId,
			taskId: request.parentSpawn.parentTaskId,
			spawnId: request.parentSpawn.spawnId,
			forkScope: "none",
			lineage: {
				schemaVersion: 1,
				entityType: "context",
				entityId: parentContextId,
				depth: 0,
			},
			createdAt: NOW,
		});
	}
	return {
		schemaVersion: 1,
		request,
		originParentAgentInstance: origin,
		originParentAttemptId: originAttemptId,
		lineageParentAgentInstance: lineageParent,
		childLaneId: overrides.childLaneId ?? `child-lane-${overrides.childAgentInstanceId ?? "1"}`,
		childBinding,
		providerDescriptor: descriptor,
		childAgentInstanceId: overrides.childAgentInstanceId ?? "child-1",
		dispatchId: overrides.dispatchId ?? "dispatch-1",
		attemptId: overrides.attemptId ?? "attempt-1",
		bindingEpochId: overrides.bindingEpochId ?? "epoch-1",
		activatedByCommandId: overrides.activatedByCommandId ?? "command-1",
		queue: overrides.queue ?? { mode: "fail" },
	};
}

function dispatchFromSpawn(spawned: ChildSpawnResult): Dispatch {
	return {
		schemaVersion: 1,
		dispatchId: spawned.attempt.dispatchId,
		taskId: spawned.attempt.taskId,
		bindingId: spawned.attempt.bindingId,
		taskExecutorProviderId: spawned.attempt.providerId,
		status: "pending",
		createdAt: spawned.attempt.startedAt,
	};
}

function settlementFor(value: Fixture, laneId: string): LayeredResultSettlement {
	return new LayeredResultSettlement(value.session, {
		writer: new SessionLedgerWriter(value.session, {
			ownerId: "supervisor-writer",
			lane: laneId,
		}),
	});
}

async function planChild(value: Fixture, childAgentInstanceId = "child-1"): Promise<SubagentSpawnPlan> {
	const input = await planInput(value, { childAgentInstanceId });
	const planned = await value.supervisor.planSpawn(input);
	if (!planned.ok) throw planned.error;
	return planned.value;
}

function createProvider(
	value: Fixture,
	quota: RecordingQuota,
	mode: FakeMode | ((spec: ChildAgentProcessSpawnSpec, index: number) => FakeChild),
	loadParentContext: LoadParentContext = async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
): { readonly provider: ForkChildAgentProvider; readonly children: FakeChild[] } {
	const children: FakeChild[] = [];
	const provider = new ForkChildAgentProvider({
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		supervisor: value.supervisor,
		quota,
		ledger: value.ledger,
		executable: process.execPath,
		entrypoint: ENTRYPOINT,
		environment: { AOS_CHILD_PROTOCOL: "1" },
		loadParentContext,
		now: () => NOW,
		readyTimeoutMs: 500,
		turnTimeoutMs: 500,
		cancelTimeoutMs: 50,
		closeTimeoutMs: 50,
		spawnProcess: () => {
			const child =
				typeof mode === "function" ? mode({ executable: process.execPath, entrypoint: ENTRYPOINT, environment: {}, cwd: "." }, children.length) : new FakeChild(mode, 4_000 + children.length);
			children.push(child);
			return child;
		},
	});
	return { provider, children };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

function childEntryInitialize(): {
	readonly initialize: ChildAgentInitializeRequest;
	readonly succeeded: AttemptReceipt;
} {
	const correlation = {
		sessionId: "session-entry",
		laneId: "child-lane-entry",
		taskId: "task-entry",
		dispatchId: "dispatch-entry",
		attemptId: "attempt-entry",
		bindingId: "binding-entry",
		bindingEpochId: "epoch-entry",
		agentInstanceId: "child-entry",
		providerId: PROVIDER_ID,
		revision: 0,
	};
	const initialize: ChildAgentInitializeRequest = {
		type: "initialize",
		requestId: "initialize:spawn-entry:1",
		spawnId: "spawn-entry",
		protocolVersion: CHILD_AGENT_PROTOCOL_VERSION,
		features: CHILD_AGENT_PROTOCOL_FEATURES,
		projection: {
			schemaVersion: 1,
			spawnId: "spawn-entry",
			parentBindingId: "binding-entry",
			childBindingId: "binding-entry",
			digest: { algorithm: "sha256", value: "ab".repeat(32) },
		},
		forkSnapshotRef: { schemaVersion: 1, type: "context_snapshot", id: "snapshot:spawn-entry", revision: 1 },
		contextProjection: {
			schemaVersion: 1,
			plan: {
				schemaVersion: 1,
				spawnId: "spawn-entry",
				forkScope: "none",
				childSnapshotRef: { schemaVersion: 1, type: "context_snapshot", id: "snapshot:spawn-entry", revision: 1 },
				tokenBudget: 1000,
			},
			runtime: {
				schemaVersion: 1,
				kind: "system_task",
				persona: "Run the child task.",
				customInstructions: "",
				goal: "run",
				acceptanceCriteria: [],
				inputs: [],
				expectedOutputs: [],
			},
			messages: [],
		},
		model: { provider: "fake", model: "model-1" },
		correlation,
		providerId: PROVIDER_ID,
		taskId: "task-entry",
		dispatchId: "dispatch-entry",
		attemptId: "attempt-entry",
		bindingId: "binding-entry",
		bindingEpochId: "epoch-entry",
		agentInstanceId: "child-entry",
	};
	const succeeded: AttemptReceipt = {
		schemaVersion: 1,
		attemptReceiptId: "attempt-receipt:attempt-entry",
		taskId: "task-entry",
		dispatchId: "dispatch-entry",
		attemptId: "attempt-entry",
		providerId: PROVIDER_ID,
		agentInstanceId: "child-entry",
		bindingId: "binding-entry",
		bindingEpochIds: ["epoch-entry"],
		status: "succeeded",
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "agent_executor",
			providerId: PROVIDER_ID,
			producedAt: NOW,
			correlation: { ...correlation, attemptReceiptId: "attempt-receipt:attempt-entry" },
		},
		sideEffectState: "none",
	};
	return { initialize, succeeded };
}

describe("ForkChildAgentProvider", () => {
	it("handshakes, runs a turn, and settles a legal agent_executor receipt through public gates", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const { provider, children } = createProvider(value, quota, "ok");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		if (!spawned.ok) {
			throw new Error(`${spawned.error.code}: ${spawned.error.message}; parse=${children[0]?.lastParseError ?? "none"}`);
		}
		expect(spawned.ok).toBe(true);
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		if (!executed.ok) throw executed.error;
		expect(executed.ok).toBe(true);
		const checked = validateAttemptReceiptForProvider(executed.value.receipt, {
			providerId: PROVIDER_ID,
			providerClass: "agent",
		});
		expect(checked.ok).toBe(true);
		if (!checked.ok) throw checked.error;
		expect(checked.value.provenance.producerKind).toBe("agent_executor");
		expect(quota.reservations[0]?.attribution.ownerKind).toBe("agent_executor");
		expect(quota.settlements).toHaveLength(1);
		expect(quota.settlements[0]?.usage.modelCalls).toBeGreaterThan(0);
		expect(quota.settlements[0]?.usage.toolCalls).toBeGreaterThan(0);
		expect(quota.settlements[0]?.usage.tokens).toBeGreaterThan(0);
		expect(children[0]?.initialize?.projection).toMatchObject({
			parentBindingId: "binding-task-parent",
			childBindingId: planned.childBinding.bindingId,
		});
		expect(children[0]?.initialize?.forkSnapshotRef).toEqual(planned.request.forkScope === "none"
			? children[0]?.initialize?.contextProjection.plan.childSnapshotRef
			: undefined);
		expect(children[0]?.initialize?.contextProjection.runtime.goal).toBe(planned.request.taskEnvelope.goal);
		const control = await value.ledger.get("subagent.supervisor_control", planned.agentInstance.agentInstanceId);
		expect(control?.kind === "fact" ? (control.payload as { turnCount?: unknown }).turnCount : undefined).toBe(1);
		await provider.dispose();
	});

	it("projects the live inherited parent transcript into fork initialization", async () => {
		const value = fixture();
		const input = await planInput(value);
		const planned = await value.supervisor.planSpawn({
			...input,
			request: { ...input.request, forkScope: "all" },
		});
		if (!planned.ok) throw planned.error;
		const parentSnapshot = createContextSnapshot([
			{
				type: "message",
				id: "parent-user",
				seq: 1,
				parentId: null,
				timestamp: 1,
				message: { role: "user", content: [{ type: "text", text: "inherited parent context" }], timestamp: 1 },
			},
		], {
			bindingEpochId: "parent-epoch",
			forkMode: "all",
			trust: "builtin",
			budget: { maxTokens: 1000 },
		});
		const { provider, children } = createProvider(
			value,
			new RecordingQuota(),
			"ok",
			async () => Result.ok(parentSnapshot),
		);
		const spawned = await value.supervisor.executeSpawn(planned.value, provider, settlementFor(value, planned.value.childLaneId));
		if (!spawned.ok) throw spawned.error;
		expect(children[0]?.initialize?.contextProjection.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "inherited parent context" }], timestamp: 1 },
		]);
		await provider.dispose();
	});

	it("treats malformed stdout as lost without retrying or reusing the process", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "malformed");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(false);
		if (spawned.ok) throw new Error("expected lost");
		expect(spawned.error.code).toBe("subagent_lost");
		expect(children).toHaveLength(1);
		const again = await provider.lookupSpawn(planned.request.spawnId);
		expect(again.ok).toBe(false);
		await provider.dispose();
	});

	it("treats an invalid receipt as lost without retry", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "invalid-receipt");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		expect(executed.ok).toBe(false);
		if (executed.ok) throw new Error("expected lost");
		expect(executed.error.code).toBe("subagent_lost");
		expect(children).toHaveLength(1);
		await provider.dispose();
	});

	it("treats pipe close and process exit as lost", async () => {
		for (const mode of ["disconnect", "exit"] as const) {
			const value = fixture();
			const planned = await planChild(value, `child-${mode}`);
			const { provider, children } = createProvider(value, new RecordingQuota(), mode);
			const settlement = settlementFor(value, planned.childLaneId);
			const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
			expect(spawned.ok, mode).toBe(false);
			if (spawned.ok) throw new Error(`expected lost for ${mode}`);
			expect(spawned.error.code).toBe("subagent_lost");
			expect(children).toHaveLength(1);
			await provider.dispose();
		}
	});

	it("resumes by starting a new process from the transcript reference and does not reuse the old handle", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const { provider, children } = createProvider(value, quota, "ok");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		const resumed = await provider.resume(planned.initialBindingEpoch.attemptId);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) throw resumed.error;
		expect(children).toHaveLength(2);
		expect(children[0]).not.toBe(children[1]);
		expect(children[0]?.killed).toBe(true);
		expect(children[1]?.initialize?.transcriptRef).toMatchObject({
			schemaVersion: 1,
			laneId: planned.childLaneId,
			spawnId: planned.request.spawnId,
			attemptId: planned.initialBindingEpoch.attemptId,
		});
		const checked = validateAttemptReceiptForProvider(resumed.value, {
			providerId: PROVIDER_ID,
			providerClass: "agent",
		});
		expect(checked.ok).toBe(true);
		await provider.dispose();
		expect(children[1]?.listenerCount("exit")).toBe(0);
		expect(children[1]?.listenerCount("error")).toBe(0);
	});

	it("cancels an in-flight turn and settles a cancelled receipt", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const { provider, children } = createProvider(value, quota, "hang-turn");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		await waitUntil(() => children[0]?.turnRequestId !== undefined);
		const cancelled = await provider.cancel(planned.initialBindingEpoch.attemptId);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) throw cancelled.error;
		expect(children[0]?.cancelReceived).toBe(true);
		const executed = await running;
		expect(executed.ok).toBe(true);
		if (!executed.ok) throw executed.error;
		expect(executed.value.receipt.status).toBe("cancelled");
		expect(quota.settlements).toHaveLength(1);
		await provider.dispose();
	});

	it("rejects a cancelled receipt that arrives before the actual turn completion", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "cancel-receipt-only");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		if (!spawned.ok) throw spawned.error;
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		await waitUntil(() => children[0]?.turnRequestId !== undefined);
		const cancelled = await provider.cancel(planned.initialBindingEpoch.attemptId);
		expect(cancelled.ok).toBe(false);
		expect((await running).ok).toBe(false);
		expect((await provider.lookupSpawn(planned.request.spawnId)).ok).toBe(false);
		await provider.dispose();
	});

	it("rejects a succeeded receipt as cancel acknowledgement", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "cancel-succeeded");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		await waitUntil(() => children[0]?.turnRequestId !== undefined);
		const cancelled = await provider.cancel(planned.initialBindingEpoch.attemptId);
		expect(cancelled.ok).toBe(false);
		if (cancelled.ok) throw new Error("expected non-cancelled receipt to fail cancel");
		expect(cancelled.error.code).toBe("subagent_cancel_failed");
		const executed = await running;
		expect(executed.ok).toBe(false);
		await provider.dispose();
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
	});

	it("times out cancel acknowledgement with hang-cancel and fails closed", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "hang-cancel");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		await waitUntil(() => children[0]?.turnRequestId !== undefined);
		const cancelled = await provider.cancel(planned.initialBindingEpoch.attemptId);
		expect(cancelled.ok).toBe(false);
		if (cancelled.ok) throw new Error("expected cancel acknowledgement timeout");
		expect(cancelled.error.code).toBe("subagent_cancel_failed");
		expect(children[0]?.killed).toBe(true);
		const executed = await running;
		expect(executed.ok).toBe(false);
		const lookedUp = await provider.lookupSpawn(planned.request.spawnId);
		expect(lookedUp.ok).toBe(false);
		await provider.dispose();
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
	});

	it("marks a fork handle lost immediately when the cancel frame write fails", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "cancel-write-failure");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		if (!spawned.ok) throw spawned.error;
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		await waitUntil(() => children[0]?.turnRequestId !== undefined);
		const cancelled = await provider.cancel(planned.initialBindingEpoch.attemptId);
		expect(cancelled.ok).toBe(false);
		if (cancelled.ok) throw new Error("expected cancel write failure");
		expect(cancelled.error.code).toBe("subagent_lost");
		expect(children[0]?.killed).toBe(true);
		expect((await provider.lookupSpawn(planned.request.spawnId)).ok).toBe(false);
		expect((await running).ok).toBe(false);
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
		await provider.dispose();
	});

	it("trusted child entry waits for the actual cancelled turn receipt after abort", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const diagnostic = new PassThrough();
		const frames: { type: string; receipt?: AttemptReceipt; requestId?: string; code?: string; stopReason?: string }[] = [];
		let outputBuffer = "";
		output.on("data", (chunk: string | Buffer) => {
			outputBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = outputBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = outputBuffer.slice(0, newline + 1);
				outputBuffer = outputBuffer.slice(newline + 1);
				const parsed = parseChildAgentFrame(line);
				if (parsed.ok) frames.push(parsed.value);
				newline = outputBuffer.indexOf("\n");
			}
		});
		const { initialize, succeeded } = childEntryInitialize();
		const actualCancelled: AttemptReceipt = { ...succeeded, status: "cancelled" };
		let turnStarted = false;
		let abortObserved = false;
		let cancelObserved = false;
		let releaseTurn: () => void = () => undefined;
		const turnHold = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const runtime: ChildAgentEntryRuntime = {
			initialize: async () => Result.ok(undefined),
			turn: async (_frame, signal) => {
				turnStarted = true;
				if (signal.aborted) abortObserved = true;
				else signal.addEventListener("abort", () => {
					abortObserved = true;
				}, { once: true });
				await turnHold;
				return Result.ok({
					receipt: actualCancelled,
					usage: { tokens: 3, modelCalls: 1, toolCalls: 1 },
					stopReason: "stop",
				});
			},
			cancel: async () => {
				cancelObserved = true;
				return Result.ok(undefined);
			},
			close: async () => undefined,
		};
		const running = runChildAgentProcess({
			runtime,
			input,
			output,
			diagnostic,
			now: () => NOW,
		});
		input.write(serializeChildAgentFrameLine(initialize));
		await waitUntil(() => frames.some((frame) => frame.type === "ready"));
		input.write(
			serializeChildAgentFrameLine({
				type: "turn",
				requestId: "turn:spawn-entry:1",
				spawnId: "spawn-entry",
				attemptId: "attempt-entry",
				input: { kind: "prompt", text: "run" },
			}),
		);
		await waitUntil(() => turnStarted);
		input.write(
			serializeChildAgentFrameLine({
				type: "cancel",
				requestId: "cancel:spawn-entry:1",
				spawnId: "spawn-entry",
				attemptId: "attempt-entry",
				reason: "cancel",
			}),
		);
		await waitUntil(() => abortObserved && cancelObserved);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(frames.some((frame) => frame.type === "receipt")).toBe(false);
		expect(frames.some((frame) => frame.type === "turn.completed")).toBe(false);
		releaseTurn();
		await waitUntil(() => frames.some((frame) => frame.type === "receipt"));
		const receipts = frames.filter((frame) => frame.type === "receipt");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.receipt?.status).toBe("cancelled");
		expect(receipts[0]?.requestId).toBe("turn:spawn-entry:1");
		expect(frames.find((frame) => frame.type === "turn.completed")?.stopReason).toBe("aborted");
		expect(frames.filter((frame) => frame.type === "receipt")).toHaveLength(1);
		expect(frames.findIndex((frame) => frame.type === "turn.completed")).toBeLessThan(
			frames.findIndex((frame) => frame.type === "receipt"),
		);
		input.write(
			serializeChildAgentFrameLine({
				type: "close",
				requestId: "close:spawn-entry:1",
				spawnId: "spawn-entry",
			}),
		);
		await running;
		expect(frames.some((frame) => frame.type === "closed")).toBe(true);
	});

	it.each([
		{ status: "failed" as const, expectedStopReason: "error" },
		{ status: "suspended" as const, expectedStopReason: "tool_use" },
	])("correlates a $status receipt with the protocol stop reason", async ({ status, expectedStopReason }) => {
		const input = new PassThrough();
		const output = new PassThrough();
		const frames: { type: string; receipt?: AttemptReceipt; stopReason?: string }[] = [];
		let outputBuffer = "";
		output.on("data", (chunk: string | Buffer) => {
			outputBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = outputBuffer.indexOf("\n");
			while (newline >= 0) {
				const parsed = parseChildAgentFrame(outputBuffer.slice(0, newline + 1));
				outputBuffer = outputBuffer.slice(newline + 1);
				if (parsed.ok) frames.push(parsed.value);
				newline = outputBuffer.indexOf("\n");
			}
		});
		const { initialize, succeeded } = childEntryInitialize();
		const receipt: AttemptReceipt = status === "failed"
			? {
				...succeeded,
				status,
				error: { code: "child_failed", message: "Child turn failed", retryable: false },
			}
			: { ...succeeded, status };
		const runtime: ChildAgentEntryRuntime = {
			initialize: async () => Result.ok(undefined),
			turn: async () => Result.ok({
				receipt,
				usage: { tokens: 1, modelCalls: 1, toolCalls: 0 },
				stopReason: "stop",
			}),
			cancel: async () => Result.ok(undefined),
			close: async () => undefined,
		};
		const running = runChildAgentProcess({ runtime, input, output, now: () => NOW });
		input.write(serializeChildAgentFrameLine(initialize));
		await waitUntil(() => frames.some((frame) => frame.type === "ready"));
		input.write(serializeChildAgentFrameLine({
			type: "turn",
			requestId: "turn:spawn-entry:1",
			spawnId: initialize.spawnId,
			attemptId: initialize.attemptId,
			input: { kind: "prompt", text: "run" },
		}));
		await waitUntil(() => frames.some((frame) => frame.type === "receipt"));
		expect(frames.find((frame) => frame.type === "turn.completed")?.stopReason).toBe(expectedStopReason);
		expect(frames.find((frame) => frame.type === "receipt")?.receipt?.status).toBe(status);
		input.write(serializeChildAgentFrameLine({
			type: "close",
			requestId: "close:spawn-entry:1",
			spawnId: initialize.spawnId,
		}));
		await running;
	});

	it("aggregates exact usage across a retry, tool call, and final model call", async () => {
		const { initialize } = childEntryInitialize();
		const fake = fakeProvider({ provider: "fake", models: [{ id: "model-1" }] });
		const models = createModels();
		models.setProvider(fake.provider);
		let callCount = 0;
		const tool: HarnessTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes test input",
			parameters: { type: "object", properties: {}, additionalProperties: false } as HarnessTool["parameters"],
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};
		const runtime = new AgentHarnessChildAgentEntryRuntime({
			models,
			tools: [tool],
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			streamFunction: (model) => {
				callCount += 1;
				const stream = createAssistantMessageEventStream();
				const tokens = callCount === 1 ? 2 : callCount === 2 ? 3 : 5;
				const cost = callCount / 10;
				const message = {
					role: "assistant" as const,
					content: callCount === 2
						? [{ type: "toolCall" as const, id: "echo-1", name: "echo", arguments: {} }]
						: [{ type: "text" as const, text: callCount === 3 ? "done" : "" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: tokens - 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: tokens,
						cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
					},
					stopReason: callCount === 1 ? "error" as const : callCount === 2 ? "toolUse" as const : "stop" as const,
					...(callCount === 1 ? { errorMessage: "overloaded_error" } : {}),
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
			resolveModel: () => Result.ok(fake.getModel()),
			now: () => NOW,
		});
		const initialized = await runtime.initialize(initialize);
		if (!initialized.ok) throw initialized.error;
		const turned = await runtime.turn({
			type: "turn",
			requestId: "turn:spawn-entry:1",
			spawnId: initialize.spawnId,
			attemptId: initialize.attemptId,
			input: { kind: "prompt", text: "run" },
		}, new AbortController().signal);
		if (!turned.ok) throw turned.error;
		expect(callCount).toBe(3);
		expect(turned.value.usage).toMatchObject({ tokens: 10, modelCalls: 3, toolCalls: 1 });
		expect(turned.value.usage.costUsd).toBeCloseTo(0.6);
		expect(turned.value.receipt).toMatchObject({ status: "succeeded", sideEffectState: "none" });
		expect(turned.value.stopReason).toBe("stop");
		await runtime.close();
	});

	it("fails cancellation after an unproven tool side effect and reports an error stop reason", async () => {
		const { initialize } = childEntryInitialize();
		const fake = fakeProvider({ provider: "fake", models: [{ id: "model-1" }] });
		const models = createModels();
		models.setProvider(fake.provider);
		let toolStarted = false;
		let releaseTool: () => void = () => undefined;
		const toolHold = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: HarnessTool = {
			name: "mutate",
			label: "Mutate",
			description: "Mutates test state",
			parameters: { type: "object", properties: {}, additionalProperties: false } as HarnessTool["parameters"],
			execute: async () => {
				toolStarted = true;
				await toolHold;
				return { content: [{ type: "text", text: "mutated" }], details: {} };
			},
		};
		const runtime = new AgentHarnessChildAgentEntryRuntime({
			models,
			tools: [tool],
			streamFunction: (model) => {
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "toolCall" as const, id: "mutate-1", name: "mutate", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
			resolveModel: () => Result.ok(fake.getModel()),
			now: () => NOW,
		});
		const initialized = await runtime.initialize(initialize);
		if (!initialized.ok) throw initialized.error;
		const controller = new AbortController();
		const turning = runtime.turn({
			type: "turn",
			requestId: "turn:spawn-entry:1",
			spawnId: initialize.spawnId,
			attemptId: initialize.attemptId,
			input: { kind: "prompt", text: "run" },
		}, controller.signal);
		await waitUntil(() => toolStarted);
		controller.abort();
		const turned = await turning;
		if (!turned.ok) throw turned.error;
		expect(turned.value.usage).toMatchObject({ tokens: 2, modelCalls: 1, toolCalls: 1 });
		expect(turned.value.receipt).toMatchObject({
			status: "failed",
			sideEffectState: "side_effect_unknown",
			error: {
				code: "side_effect_unknown",
				category: "side_effect_unknown",
				retryable: false,
			},
		});
		expect(turned.value.stopReason).toBe("error");
		releaseTool();
		await runtime.close();
	});

	it("fails closed when runtime.cancel fails and does not emit a cancelled receipt", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const diagnostic = new PassThrough();
		const frames: { type: string; receipt?: AttemptReceipt; code?: string }[] = [];
		let outputBuffer = "";
		output.on("data", (chunk: string | Buffer) => {
			outputBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = outputBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = outputBuffer.slice(0, newline + 1);
				outputBuffer = outputBuffer.slice(newline + 1);
				const parsed = parseChildAgentFrame(line);
				if (parsed.ok) frames.push(parsed.value);
				newline = outputBuffer.indexOf("\n");
			}
		});
		const { initialize, succeeded } = childEntryInitialize();
		let turnStarted = false;
		let cancelStarted = false;
		let releaseTurn: () => void = () => undefined;
		const turnHold = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let settleCancel: (value: Awaited<ReturnType<ChildAgentEntryRuntime["cancel"]>>) => void = () => undefined;
		const cancelHold = new Promise<Awaited<ReturnType<ChildAgentEntryRuntime["cancel"]>>>((resolve) => {
			settleCancel = resolve;
		});
		const runtime: ChildAgentEntryRuntime = {
			initialize: async () => Result.ok(undefined),
			turn: async () => {
				turnStarted = true;
				await turnHold;
				return Result.ok({
					receipt: succeeded,
					usage: { tokens: 3, modelCalls: 1, toolCalls: 1 },
					stopReason: "stop",
				});
			},
			cancel: async () => {
				cancelStarted = true;
				return cancelHold;
			},
			close: async () => undefined,
		};
		const running = runChildAgentProcess({
			runtime,
			input,
			output,
			diagnostic,
			now: () => NOW,
		});
		input.write(serializeChildAgentFrameLine(initialize));
		await waitUntil(() => frames.some((frame) => frame.type === "ready"));
		input.write(
			serializeChildAgentFrameLine({
				type: "turn",
				requestId: "turn:spawn-entry:1",
				spawnId: "spawn-entry",
				attemptId: "attempt-entry",
				input: { kind: "prompt", text: "run" },
			}),
		);
		await waitUntil(() => turnStarted);
		input.write(
			serializeChildAgentFrameLine({
				type: "cancel",
				requestId: "cancel:spawn-entry:1",
				spawnId: "spawn-entry",
				attemptId: "attempt-entry",
				reason: "cancel",
			}),
		);
		await waitUntil(() => cancelStarted);
		expect(frames.some((frame) => frame.type === "receipt")).toBe(false);
		input.end();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frames.some((frame) => frame.type === "error")).toBe(false);
		settleCancel(Result.err(new FoundationError("subagent_cancel_failed", "runtime cancel failed")));
		await waitUntil(() => frames.some((frame) => frame.type === "error"));
		expect(frames.filter((frame) => frame.type === "receipt")).toHaveLength(0);
		expect(frames.filter((frame) => frame.type === "error").map((frame) => frame.code)).toEqual(["subagent_lost"]);
		await running;
		releaseTurn();
	});

	it("waits for a matching closed frame and reaps listeners on close", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "ok");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		expect(executed.ok).toBe(true);
		const closed = await provider.close(planned.initialBindingEpoch.attemptId);
		expect(closed.ok).toBe(true);
		expect(children[0]?.closeReceived).toBe(true);
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
		await provider.dispose();
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
	});

	it("drains child stderr without retaining its contents", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "ok");
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlementFor(value, planned.childLaneId));
		if (!spawned.ok) throw spawned.error;
		const child = children[0];
		if (child === undefined) throw new Error("missing child");
		expect(child.stderr.listenerCount("data")).toBe(1);
		child.stderr.write("verbose child diagnostic\n".repeat(32_768));
		await waitUntil(() => child.stderr.readableLength === 0);
		await provider.dispose();
		expect(child.stderr.listenerCount("data")).toBe(0);
	});

	it("fails closed when close acknowledgement times out and does not leak listeners", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "hang-close");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const closed = await provider.close(planned.initialBindingEpoch.attemptId);
		expect(closed.ok).toBe(false);
		if (closed.ok) throw new Error("expected close acknowledgement timeout");
		expect(closed.error.code).toBe("subagent_close_unknown");
		expect(children[0]?.closeReceived).toBe(true);
		expect(children[0]?.killed).toBe(true);
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
		await provider.dispose();
	});

	it("fails closed when a matching closed frame arrives without process exit", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "closed-without-exit");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const closed = await provider.close(planned.initialBindingEpoch.attemptId);
		expect(closed.ok).toBe(false);
		if (closed.ok) throw new Error("expected close without exit to fail");
		expect(closed.error.code).toBe("subagent_close_unknown");
		expect(children[0]?.closeReceived).toBe(true);
		expect(children[0]?.killed).toBe(true);
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
		await provider.dispose();
	});

	it("fails closed when the closed frame does not match the close request", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const { provider, children } = createProvider(value, new RecordingQuota(), "mismatched-closed");
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const closed = await provider.close(planned.initialBindingEpoch.attemptId);
		expect(closed.ok).toBe(false);
		if (closed.ok) throw new Error("expected mismatched closed frame to fail");
		expect(closed.error.code).toBe("subagent_close_unknown");
		expect(children[0]?.closeReceived).toBe(true);
		expect(children[0]?.killed).toBe(true);
		expect(children[0]?.listenerCount("exit")).toBe(0);
		expect(children[0]?.listenerCount("error")).toBe(0);
		await provider.dispose();
	});

	it("rejects credential and session material in the child environment", () => {
		const value = fixture();
		expect(
			() =>
				new ForkChildAgentProvider({
					schemaVersion: 1,
					providerId: PROVIDER_ID,
					supervisor: value.supervisor,
					quota: new RecordingQuota(),
					ledger: value.ledger,
					executable: process.execPath,
					entrypoint: ENTRYPOINT,
					environment: { OPENAI_API_KEY: "secret" },
					loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
				}),
		).toThrowError(/invalid/i);
		expect(
			() =>
				new ForkChildAgentProvider({
					schemaVersion: 1,
					providerId: PROVIDER_ID,
					supervisor: value.supervisor,
					quota: new RecordingQuota(),
					ledger: value.ledger,
					executable: process.execPath,
					entrypoint: ENTRYPOINT,
					environment: { WORKSPACE_PATH: "C:\\tmp\\.aos-agent\\sessions\\secret" },
					loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
				}),
		).toThrowError(/invalid/i);
	});

	it.skipIf(!RUN_REAL_FORK_SMOKE)("runs the trusted AgentHarness child in a real OS process with fake output", async () => {
		const root = await mkdtemp(join(tmpdir(), "aos-real-fork-"));
		const value = fixture();
		const input = await planInput(value);
		const plannedResult = await value.supervisor.planSpawn({
			...input,
			request: { ...input.request, forkScope: "all" },
		});
		if (!plannedResult.ok) throw plannedResult.error;
		const planned = plannedResult.value;
		const parentSnapshot = createContextSnapshot([{
			type: "message",
			id: "real-parent-user",
			seq: 1,
			parentId: null,
			timestamp: 1,
			message: { role: "user", content: [{ type: "text", text: CHILD_AGENT_PARENT_CONTEXT }], timestamp: 1 },
		}], {
			bindingEpochId: "real-parent-epoch",
			forkMode: "all",
			trust: "builtin",
			budget: { maxTokens: 1000 },
		});
		const outputs: string[] = [];
		const provider = new ForkChildAgentProvider({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota: new RecordingQuota(),
			ledger: value.ledger,
			executable: process.execPath,
			entrypoint: REAL_ENTRYPOINT,
			workingDirectory: root,
			environment: {
				TSX_TSCONFIG_PATH: ROOT_TSCONFIG,
				TEMP: root,
				TMP: root,
				...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
				...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
			},
			loadParentContext: async () => Result.ok(parentSnapshot),
			onTurnOutput: ({ output }) => outputs.push(output),
			spawnProcess: (spec) => spawn(spec.executable, [`--import=${TSX_IMPORT}`, spec.entrypoint], {
				cwd: spec.cwd,
				env: spec.environment,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}),
			readyTimeoutMs: 10_000,
			turnTimeoutMs: 10_000,
			closeTimeoutMs: 10_000,
		});
		try {
			const settlement = settlementFor(value, planned.childLaneId);
			const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
			if (!spawned.ok) throw spawned.error;
			const executed = await settlement.executeDispatch({
				dispatch: dispatchFromSpawn(spawned.value),
				binding: planned.childBinding,
				initialBindingEpoch: spawned.value.initialBindingEpoch,
				provider,
				agentInstance: spawned.value.agentInstance,
				correlation: planned.correlation,
			});
			if (!executed.ok) throw executed.error;
			if (executed.value.receipt.status !== "succeeded") {
				throw new Error(`${JSON.stringify(executed.value.receipt)} outputs=${JSON.stringify(outputs)}`);
			}
			expect(executed.value.receipt.status).toBe("succeeded");
			expect(outputs).toEqual([CHILD_AGENT_ENTRY_SENTINEL]);
			const closed = await provider.close(planned.initialBindingEpoch.attemptId);
			expect(closed.ok).toBe(true);
		} finally {
			await provider.dispose();
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
});
