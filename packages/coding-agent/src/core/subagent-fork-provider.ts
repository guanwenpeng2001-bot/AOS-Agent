/**
 * Fork ChildAgentProvider: trusted local child process + private stdio JSONL.
 *
 * Resume always starts a new process from a durable transcript reference.
 * Pipe close, process exit, malformed frames, and invalid receipts are lost
 * with no automatic retry and no reuse of the old handle.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	cloneDeepFrozen,
	createAgentInstance,
	createAttempt,
	createBindingEpoch,
	FoundationError,
	FoundationObserver,
	Result,
	validateAgentInstance,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateChildSpawnRequest,
	validateImmutableAgentBinding,
	validateQuotaReservation,
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type Dispatch,
	type ExecutionCorrelation,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ObserverCursor,
	type BudgetUsage,
	type QuotaProvider,
	type QuotaReservation,
	type Result as ResultValue,
	type SessionLedger,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import { attachJsonlLineReader } from "../modes/rpc/jsonl.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import { FORK_PROVIDER } from "./subagent-registry.ts";
import {
	CHILD_BINDING_PROJECTION_OBJECT_TYPE,
	validateChildBindingProjection,
	type ChildBindingProjection,
} from "./subagent-binding.ts";
import type { ChildContextForkResult } from "./subagent-context-fork.ts";
import {
	projectProviderChildContext,
	type LoadParentContext,
} from "./subagent-provider-context.ts";
import {
	childAgentQuotaAttribution,
	type ChildAgentBackgroundAttach,
} from "./subagent-inprocess-provider.ts";
import {
	CHILD_AGENT_PROTOCOL_FEATURES,
	CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES,
	CHILD_AGENT_PROTOCOL_VERSION,
	childAgentUsageIsPresent,
	ChildAgentProtocolSession,
	parseChildAgentFrame,
	serializeChildAgentFrameLine,
	type ChildAgentCancelReason,
	type ChildAgentInitializeRequest,
	type ChildAgentProtocolFrame,
	type ChildAgentTranscriptRef,
} from "./subagent-fork-protocol.ts";
import type { SubagentProviderSpawnPlan, SubagentSupervisor } from "./subagent-supervisor.ts";

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 15_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const SECRET_ENVIRONMENT_KEY = /(auth|cookie|credential|header|key|password|secret|token|mcp|session)/i;
const SAFE_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SESSION_PATH_PATTERN = /(?:^|[\\/])(?:\.aos-agent|sessions?)(?:[\\/]|$)/i;

export interface ChildAgentProcess {
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly pid?: number;
	killed: boolean;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	removeListener(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	removeListener(event: "error", listener: (error: Error) => void): this;
}

export interface ChildAgentProcessSpawnSpec {
	readonly executable: string;
	readonly entrypoint: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly cwd: string;
}

export interface ForkChildAgentProviderOptions {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly supervisor: SubagentSupervisor;
	readonly quota: QuotaProvider;
	readonly ledger: SessionLedger;
	readonly executable: string;
	readonly entrypoint: string;
	readonly workingDirectory?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly loadParentContext: LoadParentContext;
	readonly loadTurnBoundaryContext?: (input: {
		readonly schemaVersion: 1;
		readonly spawnId: string;
		readonly attemptId: string;
		readonly childAgentInstanceId: string;
	}) => Promise<ResultValue<string | undefined, FoundationError>>;
	readonly onTurnOutput?: (input: { readonly spawnId: string; readonly attemptId: string; readonly output: string }) => void;
	readonly spawnProcess?: (spec: ChildAgentProcessSpawnSpec) => ChildAgentProcess;
	readonly now?: () => string;
	readonly readyTimeoutMs?: number;
	readonly turnTimeoutMs?: number;
	readonly cancelTimeoutMs?: number;
	readonly closeTimeoutMs?: number;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly settled: () => boolean;
}

interface ForkChildHandleV1 {
	readonly spawnId: string;
	spawn: ChildSpawnResult;
	readonly request: ChildSpawnRequest;
	readonly correlation: ExecutionCorrelation;
	readonly binding: AgentBinding;
	readonly bindingProjection: ChildBindingProjection;
	readonly contextFork: ChildContextForkResult;
	readonly childLaneId: string;
	generation: number;
	child?: ChildAgentProcess;
	protocol: ChildAgentProtocolSession;
	quotaReservation?: QuotaReservation;
	turnUsage?: BudgetUsage;
	detachStdout?: () => void;
	detachStderr?: () => void;
	exitListener?: (code: number | null, signal: NodeJS.Signals | null) => void;
	errorListener?: (error: Error) => void;
	readyWaiter?: Deferred<ResultValue<void, FoundationError>>;
	receiptWaiter?: Deferred<ResultValue<AttemptReceipt, FoundationError>>;
	closeWaiter?: Deferred<ResultValue<void, FoundationError>>;
	closeRequestId?: string;
	closeAcked: boolean;
	exited: boolean;
	timers: Set<ReturnType<typeof setTimeout>>;
	observer?: FoundationObserver;
	background: boolean;
	closed: boolean;
	lost: boolean;
	receipt?: AttemptReceipt;
	transcriptRef?: ChildAgentTranscriptRef;
	spawnCount: number;
	turnCount: number;
}

const DEFAULT_CAPABILITIES: readonly FoundationProviderCapability[] = Object.freeze([
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.fork", version: 1 }),
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.resume", version: 1 }),
	Object.freeze({ schemaVersion: 1 as const, id: "child_agent.background", version: 1 }),
]);

function fail(code: ConstructorParameters<typeof FoundationError>[0], message: string): FoundationError {
	return new FoundationError(code, message);
}

function deferred<T>(): Deferred<T> {
	let settle: ((value: T) => void) | undefined;
	let done = false;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return {
		promise,
		resolve: (value) => {
			if (done) return;
			done = true;
			settle!(value);
		},
		settled: () => done,
	};
}

function isPositiveTimeout(value: number | undefined): boolean {
	return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function environmentIsSafe(value: Readonly<Record<string, string>>): boolean {
	return Object.entries(value).every(
		([key, item]) =>
			SAFE_ENVIRONMENT_KEY.test(key) &&
			!SECRET_ENVIRONMENT_KEY.test(key) &&
			typeof item === "string" &&
			!item.includes("\0") &&
			!item.includes("\r") &&
			!item.includes("\n") &&
			!SESSION_PATH_PATTERN.test(item),
	);
}

function pathIsTrustedFile(value: string): boolean {
	if (!isAbsolute(value)) return false;
	try {
		return statSync(value).isFile();
	} catch {
		return false;
	}
}

function pathIsTrustedDirectory(value: string): boolean {
	if (!isAbsolute(value) || SESSION_PATH_PATTERN.test(value)) return false;
	try {
		return statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function requestId(prefix: string, spawnId: string, generation: number): string {
	return `${prefix}:${spawnId}:${generation}`;
}

export class ForkChildAgentProvider implements ChildAgentProvider, TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "agent" as const;
	readonly providerId: string;
	private readonly supervisor: SubagentSupervisor;
	private readonly quota: QuotaProvider;
	private readonly ledger: SessionLedger;
	private readonly executable: string;
	private readonly entrypoint: string;
	private readonly workingDirectory: string;
	private readonly environment: Readonly<Record<string, string>>;
	private readonly loadParentContext: LoadParentContext;
	private readonly loadTurnBoundaryContext: NonNullable<ForkChildAgentProviderOptions["loadTurnBoundaryContext"]>;
	private readonly onTurnOutput: ForkChildAgentProviderOptions["onTurnOutput"];
	private readonly spawnProcess: ((spec: ChildAgentProcessSpawnSpec) => ChildAgentProcess) | undefined;
	private readonly now: () => string;
	private readonly readyTimeoutMs: number;
	private readonly turnTimeoutMs: number;
	private readonly cancelTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly declaredCapabilities: readonly FoundationProviderCapability[];
	private readonly bySpawnId = new Map<string, ForkChildHandleV1>();
	private readonly byAttemptId = new Map<string, ForkChildHandleV1>();
	private disposed = false;

	constructor(options: ForkChildAgentProviderOptions) {
		const environment = Object.freeze({ ...(options.environment ?? {}) });
		const workingDirectory = options.workingDirectory ?? dirname(options.entrypoint);
		if (
			options.schemaVersion !== 1 ||
			typeof options.providerId !== "string" ||
			options.providerId.length === 0 ||
			options.quota.providerClass !== "quota" ||
			typeof options.loadParentContext !== "function" ||
			!pathIsTrustedFile(options.executable) ||
			!pathIsTrustedFile(options.entrypoint) ||
			!pathIsTrustedDirectory(workingDirectory) ||
			!environmentIsSafe(environment) ||
			!isPositiveTimeout(options.readyTimeoutMs) ||
			!isPositiveTimeout(options.turnTimeoutMs) ||
			!isPositiveTimeout(options.cancelTimeoutMs) ||
			!isPositiveTimeout(options.closeTimeoutMs)
		) {
			throw fail("subagent_spawn_invalid", "Fork Child Agent provider options are invalid");
		}
		this.providerId = options.providerId;
		this.supervisor = options.supervisor;
		this.quota = options.quota;
		this.ledger = options.ledger;
		this.executable = options.executable;
		this.entrypoint = options.entrypoint;
		this.workingDirectory = workingDirectory;
		this.environment = environment;
		this.loadParentContext = options.loadParentContext;
		this.loadTurnBoundaryContext = options.loadTurnBoundaryContext ?? (async () => Result.ok(undefined));
		this.onTurnOutput = options.onTurnOutput;
		this.spawnProcess = options.spawnProcess;
		this.now = options.now ?? (() => new Date().toISOString());
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
		this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		this.declaredCapabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return this.declaredCapabilities;
	}

	async spawn(
		requestValue: ChildSpawnRequest,
		options: FoundationProviderExecutionOptions,
	): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
		if (this.disposed) return Result.err(fail("subagent_provider_unavailable", "Fork Child Agent provider is disposed"));
		const checkedRequest = validateChildSpawnRequest(requestValue);
		if (!checkedRequest.ok) return checkedRequest;
		const request = checkedRequest.value;
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
		const created = await this.createSpawnResult(request, planned.value, correlation);
		if (!created.ok) return created;
		const bindingFact = await this.ledger.get("agent_binding", planned.value.bindingId);
		if (bindingFact?.kind !== "fact") {
			return Result.err(fail("subagent_spawn_invalid", "Child AgentBinding must be durable before spawn"));
		}
		const checkedBinding = validateImmutableAgentBinding(bindingFact.payload);
		if (!checkedBinding.ok) return checkedBinding;
		const projectionFact = await this.ledger.getFact<ChildBindingProjection>(
			CHILD_BINDING_PROJECTION_OBJECT_TYPE,
			request.spawnId,
		);
		if (
			projectionFact === undefined ||
			!validateChildBindingProjection(projectionFact.payload) ||
			projectionFact.payload.spawnId !== request.spawnId ||
			projectionFact.payload.childBindingId !== checkedBinding.value.bindingId
		) {
			return Result.err(fail("subagent_spawn_invalid", "Child Binding projection proof must be durable before fork spawn"));
		}
		const contextFork = await projectProviderChildContext({
			schemaVersion: 1,
			request,
			childBindingEpochId: created.value.initialBindingEpoch.bindingEpochId,
			loadParentContext: this.loadParentContext,
		});
		if (!contextFork.ok) return contextFork;
		const handle: ForkChildHandleV1 = {
			spawnId: request.spawnId,
			spawn: created.value,
			request,
			correlation,
			binding: checkedBinding.value,
			bindingProjection: projectionFact.payload,
			contextFork: contextFork.value,
			childLaneId: planned.value.childLaneId,
			generation: 1,
			protocol: new ChildAgentProtocolSession(),
			timers: new Set(),
			background: false,
			closed: false,
			lost: false,
			closeAcked: false,
			exited: false,
			spawnCount: 0,
			turnCount: 0,
			transcriptRef: {
				schemaVersion: 1,
				sessionId: correlation.sessionId,
				laneId: planned.value.childLaneId,
				spawnId: request.spawnId,
				attemptId: planned.value.attemptId,
			},
		};
		this.bySpawnId.set(request.spawnId, handle);
		this.byAttemptId.set(planned.value.attemptId, handle);
		const reserved = await this.reserveQuota(handle);
		if (!reserved.ok) {
			await this.markLost(handle, reserved.error);
			return reserved;
		}
		const started = await this.startProcess(handle, false);
		if (!started.ok) return started;
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
		const handle = this.byAttemptId.get(context.initialBindingEpoch.attemptId);
		if (handle !== undefined) {
			if (
				handle.spawn.attempt.dispatchId !== dispatch.dispatchId ||
				handle.spawn.attempt.taskId !== dispatch.taskId ||
				handle.spawn.attempt.bindingId !== binding.bindingId
			) {
				return Result.err(fail("subagent_conflict", "Child Agent Attempt identity collides"));
			}
			return Result.ok(cloneDeepFrozen(handle.spawn.attempt));
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
		const checkedAttempt = validateAttempt(attempt);
		if (!checkedAttempt.ok) return checkedAttempt;
		const handle = this.byAttemptId.get(checkedAttempt.value.attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.lost) return Result.err(fail("subagent_lost", "Child Agent handle is lost"));
		if (handle.closed) return Result.err(fail("subagent_conflict", "Child Agent handle is closed"));
		if (handle.receipt !== undefined) return Result.ok(cloneDeepFrozen(handle.receipt));
		if (handle.child === undefined) {
			const started = await this.startProcess(handle, false);
			if (!started.ok) return started;
		}
		if (options?.signal?.aborted) return this.cancel(attempt.attemptId).then(() => Result.err(fail("subagent_cancel_failed", "Child Agent turn was cancelled")));
		return this.sendTurn(handle, checkedAttempt.value, options?.signal);
	}

	async cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		return this.cancel(attemptId);
	}

	async cancel(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.closed) return Result.ok(undefined);
		if (handle.receipt !== undefined) {
			if (handle.receipt.status === "cancelled") return Result.ok(undefined);
			return Result.err(fail("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
		}
		if (handle.lost || handle.child === undefined) {
			return Result.err(fail("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
		}
		const waiter = handle.receiptWaiter ?? deferred<ResultValue<AttemptReceipt, FoundationError>>();
		handle.receiptWaiter = waiter;
		const cancelFrame = {
			type: "cancel" as const,
			requestId: requestId("cancel", handle.spawnId, handle.generation),
			spawnId: handle.spawnId,
			attemptId,
			reason: "cancel" as ChildAgentCancelReason,
		};
		const applied = handle.protocol.receiveHostFrame(cancelFrame);
		if (!applied.ok) {
			await this.markLost(handle, applied.error);
			return applied;
		}
		const sent = this.writeFrame(handle, cancelFrame);
		if (!sent.ok) {
			return this.markLost(handle, sent.error);
		}
		const timed = await this.withTimeout(waiter.promise, this.cancelTimeoutMs);
		if (timed.timedOut) {
			await this.markLost(handle, fail("subagent_cancel_failed", "Child Agent cancel acknowledgment timed out"));
			await this.killProcess(handle);
			return Result.err(fail("subagent_cancel_failed", "Child Agent cancellation timed out"));
		}
		if (!timed.value.ok) return timed.value;
		if (timed.value.value.status !== "cancelled") {
			await this.markLost(handle, fail("subagent_cancel_failed", "Child Agent cancel did not confirm cancellation"));
			await this.killProcess(handle);
			return Result.err(fail("subagent_cancel_failed", "Child Agent cancellation was not confirmed"));
		}
		return Result.ok(undefined);
	}

	async resume(
		attemptId: string,
		options?: { signal?: AbortSignal },
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const handle = this.byAttemptId.get(attemptId);
		if (handle === undefined) return Result.err(fail("subagent_not_found", "Child Agent attempt is not held by this provider"));
		if (handle.closed) return Result.err(fail("subagent_resume_failed", "Child Agent handle is closed"));
		if (handle.receipt !== undefined) return Result.ok(cloneDeepFrozen(handle.receipt));
		const previousChild = handle.child;
		const previousGeneration = handle.generation;
		await this.dropProcess(handle, false);
		if (handle.child === previousChild && previousChild !== undefined) {
			return Result.err(fail("subagent_lost", "Child Agent resume reused a previous process handle"));
		}
		handle.lost = false;
		handle.generation = previousGeneration + 1;
		handle.protocol = new ChildAgentProtocolSession();
		const started = await this.startProcess(handle, true);
		if (!started.ok) return started;
		if (handle.generation === previousGeneration) {
			return Result.err(fail("subagent_lost", "Child Agent resume reused a previous process generation"));
		}
		return this.runAttempt(handle.spawn.attempt, {
			correlation: handle.correlation,
			...(options?.signal === undefined ? {} : { signal: options.signal }),
		});
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
		return Result.ok({
			schemaVersion: 1,
			attempt: createdAttempt.value,
			agentInstance: createdAgent.value,
			initialBindingEpoch: createdEpoch.value,
		});
	}

	private async startProcess(
		handle: ForkChildHandleV1,
		resume: boolean,
	): Promise<ResultValue<void, FoundationError>> {
		if (handle.child !== undefined) {
			return Result.err(fail("subagent_lost", "Child Agent process handle must not be reused"));
		}
		const spec: ChildAgentProcessSpawnSpec = {
			executable: this.executable,
			entrypoint: this.entrypoint,
			environment: this.environment,
			cwd: this.workingDirectory,
		};
		let child: ChildAgentProcess;
		try {
			child = this.spawnProcess === undefined ? this.spawnTrusted(spec) : this.spawnProcess(spec);
		} catch {
			return this.markLost(handle, fail("subagent_lost", "Child Agent process failed to start"));
		}
		handle.child = child;
		handle.exited = false;
		handle.closeAcked = false;
		handle.spawnCount += 1;
		if (child.pid !== undefined) trackDetachedChildPid(child.pid);
		const initialize = this.initializeFrame(handle, resume);
		const applied = handle.protocol.receiveHostFrame(initialize);
		if (!applied.ok) return this.markLost(handle, applied.error);
		const ready = handle.readyWaiter ?? deferred<ResultValue<void, FoundationError>>();
		handle.readyWaiter = ready;
		this.attachProcess(handle, child);
		const sent = this.writeFrame(handle, initialize);
		if (!sent.ok) return sent;
		const timed = await this.withTimeout(ready.promise, this.readyTimeoutMs);
		if (timed.timedOut) {
			return this.markLost(handle, fail("subagent_lost", "Child Agent handshake timed out"));
		}
		return timed.value;
	}

	private spawnTrusted(spec: ChildAgentProcessSpawnSpec): ChildAgentProcess {
		const child: ChildProcessWithoutNullStreams = spawn(spec.executable, [spec.entrypoint], {
			cwd: spec.cwd,
			env: { ...spec.environment },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
			windowsHide: true,
			shell: false,
		});
		return child;
	}

	private initializeFrame(handle: ForkChildHandleV1, resume: boolean): ChildAgentInitializeRequest {
		return {
			type: "initialize",
			requestId: requestId("initialize", handle.spawnId, handle.generation),
			spawnId: handle.spawnId,
			protocolVersion: CHILD_AGENT_PROTOCOL_VERSION,
			features: CHILD_AGENT_PROTOCOL_FEATURES,
			projection: {
				schemaVersion: 1,
				spawnId: handle.spawnId,
				parentBindingId: handle.bindingProjection.parentBindingId,
				childBindingId: handle.bindingProjection.childBindingId,
				digest: handle.bindingProjection.digest,
			},
			forkSnapshotRef: handle.contextFork.plan.childSnapshotRef,
			contextProjection: {
				schemaVersion: 1,
				plan: handle.contextFork.plan,
				runtime: handle.contextFork.runtimeProjection,
				messages: handle.contextFork.snapshot.messages(),
			},
			model: {
				provider: handle.request.modelProfile.provider,
				model: handle.request.modelProfile.model,
			},
			correlation: handle.correlation,
			providerId: this.providerId,
			taskId: handle.spawn.attempt.taskId,
			dispatchId: handle.spawn.attempt.dispatchId,
			attemptId: handle.spawn.attempt.attemptId,
			bindingId: handle.spawn.attempt.bindingId,
			bindingEpochId: handle.spawn.initialBindingEpoch.bindingEpochId,
			agentInstanceId: handle.spawn.agentInstance.agentInstanceId,
			...(resume && handle.transcriptRef !== undefined ? { transcriptRef: handle.transcriptRef } : {}),
		};
	}

	private attachProcess(handle: ForkChildHandleV1, child: ChildAgentProcess): void {
		const onExit = (_code: number | null, _signal: NodeJS.Signals | null): void => {
			handle.exited = true;
			if (handle.closed && !handle.lost) {
				this.maybeCompleteClose(handle);
				return;
			}
			if (!handle.closed && !handle.lost) {
				void this.markLost(handle, fail("subagent_lost", "Child Agent process exited"));
			}
		};
		const onError = (): void => {
			if (!handle.closed && !handle.lost) {
				void this.markLost(handle, fail("subagent_lost", "Child Agent process failed"));
			}
		};
		handle.exitListener = onExit;
		handle.errorListener = onError;
		child.on("exit", onExit);
		child.on("error", onError);
		if (child.stderr !== null) {
			const discardStderr = (): void => undefined;
			child.stderr.on("data", discardStderr);
			child.stderr.resume();
			handle.detachStderr = () => {
				child.stderr?.off("data", discardStderr);
				child.stderr?.pause();
			};
		}
		if (child.stdout === null) {
			void this.markLost(handle, fail("subagent_lost", "Child Agent stdout pipe is missing"));
			return;
		}
		handle.detachStdout = attachJsonlLineReader(
			child.stdout,
			(line) => {
				void this.receiveLine(handle, line);
			},
			{
				maxFrameBytes: CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES,
				onError: () => {
					void this.markLost(handle, fail("subagent_lost", "Child Agent stdout pipe was lost"));
				},
				onEnd: () => {
					if (!handle.closed && !handle.lost && !handle.protocol.state.receiptReceived) {
						void this.markLost(handle, fail("subagent_lost", "Child Agent stdout pipe closed"));
					}
				},
			},
		);
	}

	private async receiveLine(handle: ForkChildHandleV1, line: string): Promise<void> {
		const parsed = parseChildAgentFrame(line);
		if (!parsed.ok) {
			await this.markLost(handle, parsed.error);
			return;
		}
		const frame = parsed.value as ChildAgentProtocolFrame;
		if (
			frame.type !== "ready" &&
			frame.type !== "turn.started" &&
			frame.type !== "turn.completed" &&
			frame.type !== "receipt" &&
			frame.type !== "error" &&
			frame.type !== "closed"
		) {
			await this.markLost(handle, fail("subagent_lost", "Child Agent sent a host frame on stdout"));
			return;
		}
		const cancelling = handle.protocol.state.phase === "cancelling";
		const applied = handle.protocol.receiveChildFrame(frame);
		if (!applied.ok) {
			await this.markLost(handle, applied.error);
			return;
		}
		const event = applied.value.frame;
		if (event.type === "ready") {
			handle.readyWaiter?.resolve(Result.ok(undefined));
			return;
		}
		if (event.type === "turn.completed") {
			if (!childAgentUsageIsPresent(event.usage)) {
				await this.markLost(handle, fail("subagent_lost", "Child Agent turn completed without usage"));
				return;
			}
			handle.turnUsage = event.usage;
			if (event.output !== undefined) {
				this.onTurnOutput?.({ spawnId: handle.spawnId, attemptId: event.attemptId, output: event.output });
			}
			return;
		}
		if (event.type === "error") {
			await this.markLost(handle, fail("subagent_lost", "Child Agent reported a protocol error"));
			return;
		}
		if (event.type === "closed") {
			if (handle.closeRequestId !== event.requestId || handle.closeWaiter === undefined) {
				const error =
					handle.closeWaiter === undefined
						? fail("subagent_lost", "Child Agent closed frame does not match the close request")
						: fail("subagent_close_unknown", "Child Agent closed frame does not match the close request");
				await this.markLost(handle, error);
				if (handle.closeWaiter !== undefined) await this.killProcess(handle);
				return;
			}
			handle.closeAcked = true;
			this.maybeCompleteClose(handle);
			return;
		}
		if (event.type === "receipt") {
			const checked = validateAttemptReceiptForProvider(event.receipt, {
				providerId: this.providerId,
				providerClass: "agent",
			});
			if (!checked.ok) {
				await this.markLost(handle, fail("subagent_lost", "Child Agent receipt is not a legal agent_executor AttemptReceipt"));
				return;
			}
			if (
				checked.value.attemptId !== handle.spawn.attempt.attemptId ||
				checked.value.agentInstanceId !== handle.spawn.agentInstance.agentInstanceId ||
				checked.value.providerId !== this.providerId
			) {
				await this.markLost(handle, fail("subagent_lost", "Child Agent receipt identity does not match"));
				return;
			}
			if (cancelling && checked.value.status !== "cancelled") {
				await this.markLost(handle, fail("subagent_cancel_failed", "Child Agent cancel did not confirm cancellation"));
				return;
			}
			const usage = handle.turnUsage;
			if (usage === undefined || !childAgentUsageIsPresent(usage)) {
				await this.markLost(handle, fail("quota_attribution_error", "Child Agent receipt arrived without turn usage"));
				return;
			}
			const settled = await this.settleQuota(handle, usage);
			if (!settled.ok) {
				await this.markLost(handle, settled.error);
				return;
			}
			handle.receipt = checked.value;
			handle.receiptWaiter?.resolve(Result.ok(cloneDeepFrozen(checked.value)));
		}
	}

	private async sendTurn(
		handle: ForkChildHandleV1,
		attempt: Attempt,
		signal?: AbortSignal,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (handle.lost || handle.child === undefined) {
			return Result.err(fail("subagent_lost", "Child Agent process is not live"));
		}
		const waiter = handle.receiptWaiter ?? deferred<ResultValue<AttemptReceipt, FoundationError>>();
		handle.receiptWaiter = waiter;
		handle.turnUsage = undefined;
		const onAbort = (): void => {
			void this.cancel(attempt.attemptId);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const recorded = await this.supervisor.recordTurn({
			schemaVersion: 1,
			childAgentInstanceId: handle.spawn.agentInstance.agentInstanceId,
			expectedTurnCount: handle.turnCount,
		});
		if (!recorded.ok) {
			signal?.removeEventListener("abort", onAbort);
			return recorded;
		}
		handle.turnCount = recorded.value;
		const boundary = await this.loadTurnBoundaryContext({
			schemaVersion: 1,
			spawnId: handle.spawnId,
			attemptId: attempt.attemptId,
			childAgentInstanceId: handle.spawn.agentInstance.agentInstanceId,
		});
		if (!boundary.ok) {
			signal?.removeEventListener("abort", onAbort);
			return boundary;
		}
		const prompt = boundary.value === undefined
			? handle.request.taskEnvelope.goal
			: `${handle.request.taskEnvelope.goal}\n\nChild mailbox messages at this turn boundary:\n${boundary.value}`;
		const deadlineAt = handle.request.taskEnvelope.requirements?.deadlineAt;
		const turnFrame = {
			type: "turn" as const,
			requestId: requestId("turn", handle.spawnId, handle.generation),
			spawnId: handle.spawnId,
			attemptId: attempt.attemptId,
			input: { kind: "prompt" as const, text: prompt },
			...(deadlineAt === undefined ? {} : { deadlineAt }),
		};
		const applied = handle.protocol.receiveHostFrame(turnFrame);
		if (!applied.ok) {
			signal?.removeEventListener("abort", onAbort);
			return this.markLost(handle, applied.error);
		}
		const sent = this.writeFrame(handle, turnFrame);
		if (!sent.ok) {
			signal?.removeEventListener("abort", onAbort);
			return sent;
		}
		const deadlineRemaining = deadlineAt === undefined ? undefined : Date.parse(deadlineAt) - Date.now();
		if (deadlineRemaining !== undefined && (!Number.isFinite(deadlineRemaining) || deadlineRemaining <= 0)) {
			signal?.removeEventListener("abort", onAbort);
			await this.cancel(attempt.attemptId);
			return Result.err(fail("subagent_cancel_failed", "Child Agent deadline elapsed before the turn"));
		}
		const timeoutMs = deadlineRemaining === undefined ? this.turnTimeoutMs : Math.min(this.turnTimeoutMs, Math.ceil(deadlineRemaining));
		const timed = await this.withTimeout(waiter.promise, timeoutMs);
		signal?.removeEventListener("abort", onAbort);
		if (timed.timedOut) {
			return this.markLost(handle, fail("subagent_lost", "Child Agent turn timed out"));
		}
		return timed.value;
	}

	private writeFrame(handle: ForkChildHandleV1, frame: unknown): ResultValue<void, FoundationError> {
		const child = handle.child;
		if (child === undefined || child.stdin === null || handle.lost) {
			return Result.err(fail("subagent_lost", "Child Agent stdin pipe is not live"));
		}
		try {
			const line = serializeChildAgentFrameLine(frame);
			child.stdin.write(line);
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(error instanceof FoundationError ? error : fail("subagent_lost", "Child Agent frame write failed"));
		}
	}

	private async reserveQuota(handle: ForkChildHandleV1): Promise<ResultValue<QuotaReservation, FoundationError>> {
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

	private async settleQuota(
		handle: ForkChildHandleV1,
		usage: BudgetUsage,
	): Promise<ResultValue<BudgetUsage, FoundationError>> {
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

	private async markLost(
		handle: ForkChildHandleV1,
		error: FoundationError,
		notifySupervisor = true,
	): Promise<ResultValue<never, FoundationError>> {
		if (!handle.lost) {
			handle.lost = true;
			handle.protocol.markLost();
			handle.readyWaiter?.resolve(Result.err(error));
			handle.receiptWaiter?.resolve(Result.err(error));
			handle.closeWaiter?.resolve(Result.err(error));
			if (notifySupervisor) {
				const record = this.supervisor.get(handle.spawn.agentInstance.agentInstanceId);
				if (record !== undefined && record.status !== "spawning") {
					await this.supervisor.markLost(handle.spawn.agentInstance.agentInstanceId);
				}
			}
			await this.dropProcess(handle, true);
		}
		return Result.err(error);
	}

	private async killProcess(handle: ForkChildHandleV1): Promise<void> {
		const child = handle.child;
		if (child === undefined) return;
		try {
			if (child.pid !== undefined) killProcessTree(child.pid);
			else child.kill("SIGKILL");
		} catch {
			// Process may already be gone.
		}
		child.killed = true;
	}

	private async dropProcess(handle: ForkChildHandleV1, lost: boolean): Promise<void> {
		const child = handle.child;
		handle.detachStdout?.();
		handle.detachStdout = undefined;
		handle.detachStderr?.();
		handle.detachStderr = undefined;
		if (child !== undefined) {
			if (handle.exitListener !== undefined) child.off("exit", handle.exitListener);
			if (handle.errorListener !== undefined) child.off("error", handle.errorListener);
			handle.exitListener = undefined;
			handle.errorListener = undefined;
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
			if (lost || !handle.closed) await this.killProcess(handle);
		}
		handle.child = undefined;
		handle.readyWaiter = undefined;
		handle.receiptWaiter = undefined;
	}

	private maybeCompleteClose(handle: ForkChildHandleV1): void {
		if (handle.lost || handle.closeWaiter === undefined) return;
		if (handle.closeAcked && handle.exited) handle.closeWaiter.resolve(Result.ok(undefined));
	}

	private async releaseHandle(handle: ForkChildHandleV1): Promise<ResultValue<void, FoundationError>> {
		if (handle.closed) {
			await this.dropProcess(handle, false);
			return Result.ok(undefined);
		}
		handle.closed = true;
		for (const timer of handle.timers) clearTimeout(timer);
		handle.timers.clear();
		handle.observer?.close();
		handle.observer = undefined;
		if (handle.child !== undefined && !handle.lost) {
			const closeFrame = {
				type: "close" as const,
				requestId: requestId("close", handle.spawnId, handle.generation),
				spawnId: handle.spawnId,
			};
			const applied = handle.protocol.receiveHostFrame(closeFrame);
			if (!applied.ok) {
				await this.markLost(handle, applied.error);
				await this.dropProcess(handle, true);
				return Result.err(applied.error);
			}
			handle.closeRequestId = closeFrame.requestId;
			handle.closeAcked = false;
			const closeWaiter = deferred<ResultValue<void, FoundationError>>();
			handle.closeWaiter = closeWaiter;
			const sent = this.writeFrame(handle, closeFrame);
			if (!sent.ok) {
				await this.markLost(handle, sent.error);
				await this.dropProcess(handle, true);
				return sent;
			}
			const timed = await this.withTimeout(closeWaiter.promise, this.closeTimeoutMs);
			if (timed.timedOut || !handle.closeAcked || !handle.exited) {
				const error = fail("subagent_close_unknown", "Child Agent close acknowledgment timed out");
				await this.markLost(handle, error);
				await this.killProcess(handle);
				await this.dropProcess(handle, true);
				return Result.err(error);
			}
			if (!timed.value.ok) {
				await this.killProcess(handle);
				await this.dropProcess(handle, true);
				return timed.value;
			}
		}
		await this.dropProcess(handle, handle.lost);
		handle.child = undefined;
		return Result.ok(undefined);
	}

	private withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
	): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
		return new Promise((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				resolve({ timedOut: true });
			}, timeoutMs);
			timer.unref();
			promise.then(
				(value) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					resolve({ timedOut: false, value });
				},
				() => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					resolve({ timedOut: true });
				},
			);
		});
	}
}

export const FORK_CHILD_AGENT_PROVIDER_ID = FORK_PROVIDER.descriptor.providerId;
