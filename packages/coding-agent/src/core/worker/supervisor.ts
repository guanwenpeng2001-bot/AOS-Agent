/**
 * Host-side lifecycle authority for one local Operation Worker process.
 *
 * Preflight is read-only and returns an activation token. Only activate may
 * create the fixed trusted child. Process details and private protocol data
 * never enter WorkerBinding, WorkerRecord, or Foundation errors.
 */

import {
	type ChildProcessWithoutNullStreams,
	spawn,
} from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import {
	FoundationError,
	Result,
	type ResultValue,
	type SandboxOperationRequest,
	type WorkerReceipt,
} from "@aos-agent/agent-core";
import {
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	OperationWorkerProtocolSession,
	parseOperationWorkerFrame,
	serializeWorkerFrameLine,
	type WorkerCancelReason,
	type OperationWorkerEventFrame,
	type OperationWorkerRequestFrame,
	type SafeLeaseProjection,
	type SafeLeaseReference,
} from "./protocol.ts";
import {
	WORKER_SCHEMA_VERSION,
	applyWorkerHeartbeat,
	applyWorkerTransition,
	createWorkerLifecycle,
	isWorkerExecutionTerminalStatus,
	isWorkerReclaimTerminalStatus,
	validateWorkerBinding,
	validateWorkerLifecycleState,
	type WorkerBinding,
	type WorkerLifecycleState,
	type WorkerLifecycleStatus,
	type WorkerRecord,
} from "./lifecycle.ts";
import {
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_PENDING_WRITE_BYTES = WORKER_PROTOCOL_MAX_FRAME_BYTES * 2;

const SECRET_ENVIRONMENT_KEY = /(auth|cookie|credential|header|key|password|secret|token)/i;
const SAFE_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

type SupervisorErrorCode =
	| "worker_binding_invalid"
	| "worker_cancel_failed"
	| "worker_conflict"
	| "worker_deadline_exceeded"
	| "worker_invalid"
	| "worker_lost"
	| "worker_not_found"
	| "worker_operation_invalid"
	| "worker_persistence_failed"
	| "worker_profile_untrusted"
	| "worker_reclaim_failed"
	| "worker_receipt_invalid"
	| "worker_start_failed"
	| "worker_unavailable";

export interface WorkerSupervisorConfig {
	/** Absolute trusted executable selected by Host composition. */
	readonly executable: string;
	/** Absolute fixed entrypoint selected by Host composition. */
	readonly entrypoint: string;
	readonly profileId: string;
	readonly profileRevision: number;
	readonly capabilities: readonly string[];
	/** Explicit child environment. The Host environment is never inherited. */
	readonly environment?: Readonly<Record<string, string>>;
	readonly readyTimeoutMs?: number;
	readonly heartbeatTimeoutMs?: number;
	readonly cancelTimeoutMs?: number;
	readonly terminateTimeoutMs?: number;
	readonly maxPendingWriteBytes?: number;
	readonly now?: () => Date;
}

export interface WorkerSupervisorPreflightInput {
	readonly binding: WorkerBinding;
	readonly runAccepted: boolean;
}

/** Opaque, single-use activation seam returned only by successful preflight. */
export interface WorkerActivationPlan {
	readonly schemaVersion: 1;
	readonly binding: WorkerBinding;
}

export interface WorkerSupervisorSnapshot {
	readonly record?: WorkerRecord;
	readonly hasLiveProcess: boolean;
	readonly quarantined: boolean;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly settled: () => boolean;
}

type TimedWait<T> =
	| { readonly timedOut: false; readonly value: T }
	| { readonly timedOut: true };

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

function stableError(code: SupervisorErrorCode, message: string): FoundationError {
	return new FoundationError(code, message);
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
			!item.includes("\n"),
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

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function cloneBinding(binding: WorkerBinding): WorkerBinding {
	return Object.freeze({
		...binding,
		capabilitySummary: Object.freeze([...binding.capabilitySummary]),
		credentialTargetRefs: Object.freeze([...binding.credentialTargetRefs]),
	});
}

function cloneLifecycleState(state: WorkerLifecycleState): WorkerLifecycleState {
	return Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		binding: cloneBinding(state.binding),
		record: Object.freeze({ ...state.record }),
		transitions: Object.freeze(state.transitions.map((transition) => Object.freeze({ ...transition }))),
		...(state.heartbeatSequence === undefined ? {} : { heartbeatSequence: state.heartbeatSequence }),
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref();
	});
}

export class OperationWorkerSupervisor {
	private readonly config: WorkerSupervisorConfig;
	private readonly environment: Readonly<Record<string, string>>;
	private readonly now: () => Date;
	private readonly protocol = new OperationWorkerProtocolSession();
	private activationPlan?: WorkerActivationPlan;
	private activationAttempted = false;
	private child?: ChildProcessWithoutNullStreams;
	private lifecycle?: WorkerLifecycleState;
	private stdoutBuffer = "";
	private requestSequence = 0;
	private readyWaiter?: Deferred<ResultValue<WorkerRecord, FoundationError>>;
	private receiptWaiter?: Deferred<ResultValue<WorkerReceipt, FoundationError>>;
	private terminalWaiter?: Deferred<boolean>;
	private exitWaiter?: Deferred<void>;
	private watchdogTimer?: NodeJS.Timeout;
	private pendingReadyFrame?: Extract<OperationWorkerEventFrame, { type: "ready" }>;
	private pendingReceiptFrame?: Extract<OperationWorkerEventFrame, { type: "receipt" }>;
	private frameCommit?: NodeJS.Immediate;
	private processStopPromise?: Promise<void>;
	private closing = false;
	private exitSeen = false;
	private reclaimFailure = false;
	private recoveredWithoutProcess = false;
	private quarantinedValue = false;
	private reclaimPromise?: Promise<ResultValue<WorkerRecord, FoundationError>>;
	private activeSideEffect: "none" | "writes" = "writes";

	constructor(config: WorkerSupervisorConfig) {
		this.config = Object.freeze({ ...config, capabilities: Object.freeze([...config.capabilities]) });
		this.environment = Object.freeze({ ...(config.environment ?? {}) });
		this.now = config.now ?? (() => new Date());
	}

	get snapshot(): WorkerSupervisorSnapshot {
		return Object.freeze({
			...(this.lifecycle === undefined ? {} : { record: this.lifecycle.record }),
			hasLiveProcess: this.child !== undefined && !this.exitSeen,
			quarantined: this.quarantinedValue,
		});
	}

	get lifecycleState(): WorkerLifecycleState | undefined {
		return this.lifecycle;
	}

	preflight(input: WorkerSupervisorPreflightInput): ResultValue<WorkerActivationPlan, FoundationError> {
		if (this.activationAttempted || this.activationPlan !== undefined || this.lifecycle !== undefined) {
			return Result.err(stableError("worker_conflict", "Operation Worker activation cannot be reused"));
		}
		if (!input.runAccepted) {
			return Result.err(stableError("worker_unavailable", "Operation Worker requires an accepted Run"));
		}
		if (!validateWorkerBinding(input.binding)) {
			return Result.err(stableError("worker_binding_invalid", "Operation Worker binding is invalid"));
		}
		if (
			input.binding.profileId !== this.config.profileId ||
			input.binding.profileRevision !== this.config.profileRevision
		) {
			return Result.err(stableError("worker_profile_untrusted", "Operation Worker profile is not trusted"));
		}
		if (!sameStringSequence(input.binding.capabilitySummary, this.config.capabilities)) {
			return Result.err(stableError("worker_unavailable", "Operation Worker capabilities are unavailable"));
		}
		if (
			!pathIsTrustedFile(this.config.executable) ||
			!pathIsTrustedFile(this.config.entrypoint) ||
			!environmentIsSafe(this.environment)
		) {
			return Result.err(stableError("worker_profile_untrusted", "Operation Worker launcher is not trusted"));
		}
		if (
			!isPositiveTimeout(this.config.readyTimeoutMs) ||
			!isPositiveTimeout(this.config.heartbeatTimeoutMs) ||
			!isPositiveTimeout(this.config.cancelTimeoutMs) ||
			!isPositiveTimeout(this.config.terminateTimeoutMs) ||
			!isPositiveTimeout(this.config.maxPendingWriteBytes)
		) {
			return Result.err(stableError("worker_invalid", "Operation Worker bounds are invalid"));
		}
		if (
			input.binding.deadlineAt !== undefined &&
			input.binding.deadlineAt <= this.now().getTime()
		) {
			return Result.err(stableError("worker_deadline_exceeded", "Operation Worker deadline has elapsed"));
		}
		const plan: WorkerActivationPlan = Object.freeze({
			schemaVersion: WORKER_SCHEMA_VERSION,
			binding: cloneBinding(input.binding),
		});
		this.activationPlan = plan;
		return Result.ok(plan);
	}

	async activate(plan: WorkerActivationPlan): Promise<ResultValue<WorkerRecord, FoundationError>> {
		if (this.activationAttempted || plan !== this.activationPlan) {
			return Result.err(stableError("worker_conflict", "Operation Worker activation token is invalid"));
		}
		this.activationAttempted = true;
		this.activationPlan = undefined;
		const created = createWorkerLifecycle(plan.binding, this.timestamp());
		if (!created.ok) return created;
		this.lifecycle = created.value;
		const starting = this.transition("starting");
		if (!starting.ok) return starting;

		try {
			this.child = spawn(this.config.executable, [this.config.entrypoint], {
				cwd: dirname(this.config.entrypoint),
				env: { ...this.environment },
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
				windowsHide: true,
				shell: false,
			});
		} catch {
			this.transition("failed", { sideEffectState: "none" });
			return Result.err(stableError("worker_start_failed", "Operation Worker failed to start"));
		}

		const child = this.child;
		this.readyWaiter = deferred();
		this.exitWaiter = deferred();
		this.attachProcessListeners(child);
		if (child.pid === undefined) {
			const failure = this.failStart();
			await this.ensureProcessStoppedAndCleaned();
			return Result.err(failure);
		}
		trackDetachedChildPid(child.pid);

		const initialize: OperationWorkerRequestFrame = {
			type: "initialize",
			requestId: this.nextRequestId("initialize"),
			binding: plan.binding,
		};
		const sent = await this.sendFrame(initialize);
		if (!sent.ok) {
			this.markLost(sent.error.code === "worker_operation_invalid" ? "worker_operation_invalid" : "worker_lost");
			await this.ensureProcessStoppedAndCleaned();
			return Result.err(sent.error);
		}

		const timeoutMs = Math.min(
			this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			this.remainingDeadlineMs(plan.binding),
		);
		const ready = await this.withTimeout(this.readyWaiter.promise, timeoutMs);
		if (!ready.timedOut) {
			if (!ready.value.ok) {
				await this.ensureProcessStoppedAndCleaned();
				return ready.value;
			}
			if (
				this.lifecycle?.record.status !== "ready" ||
				this.child === undefined ||
				this.exitSeen ||
				this.closing
			) {
				const failure = this.markLost("worker_lost");
				await this.ensureProcessStoppedAndCleaned();
				return Result.err(failure);
			}
			return ready.value;
		}

		const failure = stableError("worker_start_failed", "Operation Worker readiness timed out");
		if (this.lifecycle?.record.status === "starting") {
			this.transition("failed", { sideEffectState: "none" });
		}
		this.readyWaiter.resolve(Result.err(failure));
		await this.ensureProcessStoppedAndCleaned();
		return Result.err(failure);
	}

	async execute(request: SandboxOperationRequest): Promise<ResultValue<WorkerReceipt, FoundationError>> {
		if (
			this.child === undefined ||
			this.lifecycle === undefined ||
			this.lifecycle.record.status !== "ready" ||
			this.receiptWaiter !== undefined
		) {
			return Result.err(stableError("worker_conflict", "Operation Worker is not ready"));
		}
		if (request.operationId.length === 0) {
			return Result.err(stableError("worker_operation_invalid", "Operation Worker request is invalid"));
		}
		this.receiptWaiter = deferred();
		this.terminalWaiter = deferred();
		this.activeSideEffect = request.sideEffect ?? "writes";
		const frame: OperationWorkerRequestFrame = {
			type: "execute",
			requestId: this.nextRequestId("execute"),
			workerId: this.lifecycle.binding.workerId,
			operationId: request.operationId,
			request,
		};
		// Recast the watchdog against the current clock before sendFrame. A
		// jumped `now()` can leave a stale heartbeat timer that would otherwise
		// fire inside the deadline window and be misclassified as worker_lost.
		this.armWatchdog();
		const sent = await this.sendFrame(frame);
		if (this.receiptWaiter.settled()) {
			const outcome = await this.receiptWaiter.promise;
			if (!outcome.ok && this.snapshot.record?.status === "lost") await this.ensureProcessStoppedAndCleaned();
			return outcome;
		}
		if (!sent.ok) {
			this.markLost("worker_operation_invalid");
			await this.ensureProcessStoppedAndCleaned();
			return Result.err(sent.error);
		}
		this.armWatchdog();
		const outcome = await this.receiptWaiter.promise;
		if (!outcome.ok) {
			if (this.snapshot.record?.status === "lost") await this.ensureProcessStoppedAndCleaned();
			return outcome;
		}
		const expectedStatus: WorkerLifecycleStatus =
			outcome.value.status === "succeeded"
				? "completed"
				: outcome.value.status === "failed"
					? "failed"
					: "cancelled";
		if (this.snapshot.record?.status !== expectedStatus) {
			const failure = this.markLost("worker_lost");
			await this.ensureProcessStoppedAndCleaned();
			return Result.err(failure);
		}
		return outcome;
	}

	async cancel(
		reason: WorkerCancelReason = "cancel",
		operationId?: string,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (this.lifecycle.record.status === "lost") {
			return Result.err(stableError("worker_lost", "Operation Worker lost a trusted terminal outcome"));
		}
		if (isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) return Result.ok(undefined);
		if (this.child === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (this.lifecycle.record.status !== "ready" && this.lifecycle.record.status !== "running" && this.lifecycle.record.status !== "cancelling") {
			return Result.err(stableError("worker_conflict", "Operation Worker cannot be cancelled"));
		}

		if (this.lifecycle.record.status !== "cancelling") {
			const transitioned = this.transition("cancelling", {
				...(this.lifecycle.record.activeOperationId === undefined
					? {}
					: { activeOperationId: this.lifecycle.record.activeOperationId }),
			});
			if (!transitioned.ok) return transitioned;
			const sent = await this.sendFrame({
				type: "cancel",
				requestId: this.nextRequestId("cancel"),
				workerId: this.lifecycle.binding.workerId,
				...(operationId === undefined ? {} : { operationId }),
				reason,
			});
			if (!sent.ok) {
				this.markLost("worker_cancel_failed");
				await this.reclaim();
				return Result.err(stableError("worker_cancel_failed", "Operation Worker cancellation failed"));
			}
		}

		if (this.terminalWaiter === undefined) {
			this.markLost("worker_cancel_failed");
			await this.reclaim();
			return Result.err(stableError("worker_cancel_failed", "Operation Worker cancellation was not confirmed"));
		}
		const settled = await this.withTimeout(
			this.terminalWaiter.promise,
			this.config.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
		);
		if (!settled.timedOut && settled.value) return Result.ok(undefined);
		this.markLost("worker_cancel_failed", "Operation Worker cancellation timed out");
		await this.reclaim();
		return Result.err(stableError("worker_cancel_failed", "Operation Worker cancellation timed out"));
	}

	/** Request safe-ref projection; a successful write is not delivery proof. */
	projectCredential(lease: SafeLeaseProjection): Promise<ResultValue<void, FoundationError>> {
		return this.sendCredentialProjection("credential.project", lease);
	}

	/** Request safe-ref renewal; a successful write is not delivery proof. */
	renewCredential(lease: SafeLeaseProjection): Promise<ResultValue<void, FoundationError>> {
		return this.sendCredentialProjection("credential.renew", lease);
	}

	/** Request safe-ref revocation; a successful write is not revocation proof. */
	revokeCredential(leaseRef: SafeLeaseReference): Promise<ResultValue<void, FoundationError>> {
		const workerId = this.lifecycle?.binding.workerId;
		if (workerId === undefined || this.lifecycle === undefined || isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) {
			return Promise.resolve(Result.err(stableError("worker_lost", "Operation Worker is unavailable for credential revocation")));
		}
		return this.sendFrame({
			type: "credential.revoke",
			requestId: this.nextRequestId("credential-revoke"),
			workerId,
			leaseRef,
		});
	}

	/** Fail closed after Host credential delivery fails; accepts no credential data. */
	async failCredentialDelivery(workerId: string): Promise<ResultValue<WorkerRecord, FoundationError>> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (workerId !== this.lifecycle.binding.workerId) {
			return Result.err(stableError("worker_conflict", "Operation Worker identity conflicts"));
		}
		const status = this.lifecycle.record.status;
		if (
			isWorkerExecutionTerminalStatus(status) ||
			status === "reclaiming" ||
			isWorkerReclaimTerminalStatus(status)
		) {
			return Result.ok(this.lifecycle.record);
		}
		if (status !== "starting" && status !== "ready" && status !== "running" && status !== "cancelling") {
			return Result.err(stableError("worker_conflict", "Operation Worker cannot fail credential delivery"));
		}
		this.markLost("worker_lost");
		const record = this.lifecycle.record.status === "lost" ? this.lifecycle.record : undefined;
		await this.ensureProcessStoppedAndCleaned();
		if (record === undefined) {
			return Result.err(stableError("worker_persistence_failed", "Operation Worker loss was not persisted"));
		}
		return Result.ok(record);
	}

	async terminate(reason: WorkerCancelReason = "shutdown"): Promise<ResultValue<WorkerRecord, FoundationError>> {
		if (
			this.lifecycle !== undefined &&
			!isWorkerExecutionTerminalStatus(this.lifecycle.record.status) &&
			this.lifecycle.record.status !== "reclaiming" &&
			!isWorkerReclaimTerminalStatus(this.lifecycle.record.status)
		) {
			await this.cancel(reason, this.lifecycle.record.activeOperationId);
		}
		return this.reclaim();
	}

	dispose(): Promise<ResultValue<WorkerRecord, FoundationError>> {
		return this.terminate("shutdown");
	}

	reclaim(): Promise<ResultValue<WorkerRecord, FoundationError>> {
		this.reclaimPromise ??= this.performReclaim();
		return this.reclaimPromise;
	}

	/** Restore safe facts only. No process, handle, lease, or protocol session is recreated. */
	recover(state: WorkerLifecycleState): ResultValue<WorkerRecord, FoundationError> {
		if (
			this.activationAttempted ||
			this.lifecycle !== undefined ||
			!validateWorkerLifecycleState(state) ||
			state.binding.profileId !== this.config.profileId ||
			state.binding.profileRevision !== this.config.profileRevision ||
			!sameStringSequence(state.binding.capabilitySummary, this.config.capabilities)
		) {
			return Result.err(stableError("worker_persistence_failed", "Operation Worker recovery state is invalid"));
		}
		this.activationAttempted = true;
		this.recoveredWithoutProcess = true;
		this.lifecycle = cloneLifecycleState(state);
		const status = state.record.status;
		if (status === "starting" || status === "ready" || status === "running" || status === "cancelling") {
			const lost = this.transition("lost", {
				...(state.record.activeOperationId === undefined
					? {}
					: { activeOperationId: state.record.activeOperationId }),
				sideEffectState: "side_effect_unknown",
			});
			if (!lost.ok) return lost;
		}
		return Result.ok(this.lifecycle.record);
	}

	private async performReclaim(): Promise<ResultValue<WorkerRecord, FoundationError>> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (isWorkerReclaimTerminalStatus(this.lifecycle.record.status)) {
			return Result.ok(this.lifecycle.record);
		}
		if (!isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) {
			this.markLost("worker_lost");
		}
		if (this.lifecycle.record.status !== "reclaiming") {
			const reclaiming = this.transition("reclaiming");
			if (!reclaiming.ok) return reclaiming;
		}

		this.closing = true;
		if (this.child !== undefined && !this.exitSeen && this.protocol.state.phase !== "lost") {
			const sent = await this.sendFrame({
				type: "reclaim",
				requestId: this.nextRequestId("reclaim"),
				workerId: this.lifecycle.binding.workerId,
			});
			if (!sent.ok) this.reclaimFailure = true;
		}
		this.child?.stdin.end();

		let exited = this.exitSeen;
		if (!exited && this.exitWaiter !== undefined) {
			exited = !(await this.withTimeout(
				this.exitWaiter.promise,
				this.config.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
			)).timedOut;
		}
		if (!exited) {
			await this.stopProcessTree();
			if (this.exitWaiter !== undefined) {
				exited = !(await this.withTimeout(
					this.exitWaiter.promise,
					this.config.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
				)).timedOut;
			}
		}

		const unknown = this.recoveredWithoutProcess || this.reclaimFailure || !exited;
		this.quarantinedValue = unknown;
		this.cleanupProcess();
		const finished = this.transition(unknown ? "reclaim_unknown" : "reclaimed");
		return finished.ok ? Result.ok(finished.value) : finished;
	}

	private attachProcessListeners(child: ChildProcessWithoutNullStreams): void {
		child.stdout.setEncoding("utf8");
		child.stdin.on("error", this.onStdinError);
		child.stdout.on("data", this.onStdoutData);
		child.stdout.on("end", this.onStdoutEnd);
		child.stderr.on("data", this.onStderrData);
		child.on("error", this.onProcessError);
		child.on("exit", this.onProcessExit);
		child.on("close", this.onProcessExit);
	}

	private readonly onStdoutData = (chunk: string): void => {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.stdoutBuffer.slice(0, newline + 1);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > WORKER_PROTOCOL_MAX_FRAME_BYTES) {
				this.protocolFailure("worker_operation_invalid");
				return;
			}
			this.handleWorkerLine(line);
			if (this.closing && this.lifecycle?.record.status === "lost") break;
		}
		if (Buffer.byteLength(this.stdoutBuffer, "utf8") > WORKER_PROTOCOL_MAX_FRAME_BYTES) {
			this.protocolFailure("worker_operation_invalid");
		}
	};

	private readonly onStdoutEnd = (): void => {
		if (this.stdoutBuffer.length > 0 || (!this.closing && !this.hasTrustedExecutionTerminal())) {
			this.protocolFailure("worker_lost");
		}
	};

	private readonly onStderrData = (chunk: Buffer): void => {
		// Drain the private diagnostic pipe. Raw diagnostics are intentionally discarded.
		void chunk;
	};

	private readonly onStdinError = (error: Error): void => {
		void error;
		if (!this.closing) this.protocolFailure("worker_lost");
	};

	private readonly onProcessError = (error: Error): void => {
		void error;
		if (this.closing) return;
		if (this.lifecycle?.record.status === "starting") {
			this.failStart();
			void this.ensureProcessStoppedAndCleaned();
			return;
		}
		this.protocolFailure("worker_lost");
	};

	private readonly onProcessExit = (): void => {
		if (this.exitSeen) return;
		this.exitSeen = true;
		const pid = this.child?.pid;
		if (pid !== undefined) untrackDetachedChildPid(pid);
		this.exitWaiter?.resolve();
		if (!this.closing && !this.hasTrustedExecutionTerminal()) this.protocolFailure("worker_lost");
	};

	private handleWorkerLine(line: string): void {
		const parsed = parseOperationWorkerFrame(line);
		if (!parsed.ok || !this.isWorkerEvent(parsed.value)) {
			this.protocolFailure("worker_operation_invalid");
			return;
		}
		if (
			parsed.value.type === "heartbeat" &&
			this.lifecycle !== undefined &&
			parsed.value.workerId === this.lifecycle.binding.workerId &&
			(this.pendingReceiptFrame !== undefined || isWorkerExecutionTerminalStatus(this.lifecycle.record.status))
		) {
			return;
		}
		const accepted = this.protocol.receiveWorkerFrame(parsed.value);
		if (!accepted.ok) {
			this.protocolFailure(
				parsed.value.type === "receipt" ? "worker_receipt_invalid" : "worker_operation_invalid",
			);
			return;
		}
		this.handleWorkerEvent(parsed.value);
	}

	private handleWorkerEvent(frame: OperationWorkerEventFrame): void {
		if (frame.type === "ready") {
			this.pendingReadyFrame = frame;
			this.scheduleFrameCommit();
			return;
		}
		if (frame.type === "heartbeat") {
			if (this.lifecycle === undefined || isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) return;
			if (this.deadlineElapsed()) {
				this.protocolFailure(
					"worker_deadline_exceeded",
					"Operation Worker deadline timed out",
				);
				return;
			}
			const heartbeatAt = [
				frame.at,
				this.lifecycle.transitions.at(-1)?.at ?? this.lifecycle.record.createdAt,
				this.lifecycle.record.lastHeartbeatAt ?? this.lifecycle.record.createdAt,
			].sort().at(-1)!;
			const folded = applyWorkerHeartbeat(this.lifecycle, {
				schemaVersion: WORKER_SCHEMA_VERSION,
				binding: this.lifecycle.binding,
				sequence: frame.sequence,
				at: heartbeatAt,
			});
			if (!folded.ok) {
				this.protocolFailure("worker_operation_invalid");
				return;
			}
			this.lifecycle = folded.value.state;
			this.armWatchdog();
			return;
		}
		if (frame.type === "operation.started") {
			const running = this.transition("running", { activeOperationId: frame.operationId });
			if (!running.ok) this.protocolFailure("worker_persistence_failed");
			return;
		}
		if (frame.type === "operation.data" || frame.type === "operation.completed" || frame.type === "pong") {
			return;
		}
		if (frame.type === "error") {
			if (frame.requestId !== undefined) {
				const request = this.protocol.state.requests.find((item) => item.requestId === frame.requestId);
				if (request?.type === "reclaim") {
					this.reclaimFailure = true;
					return;
				}
			}
			this.protocolFailure("worker_lost");
			return;
		}

		this.pendingReceiptFrame = frame;
		this.scheduleFrameCommit();
	}

	private scheduleFrameCommit(): void {
		if (this.frameCommit !== undefined) return;
		this.frameCommit = setImmediate(() => {
			this.frameCommit = undefined;
			this.commitPendingFrames();
		});
		this.frameCommit.unref();
	}

	private commitPendingFrames(): void {
		const readyFrame = this.pendingReadyFrame;
		const receiptFrame = this.pendingReceiptFrame;
		this.pendingReadyFrame = undefined;
		this.pendingReceiptFrame = undefined;
		if (this.closing || this.lifecycle?.record.status === "lost") return;

		if (readyFrame !== undefined) {
			if (this.lifecycle?.record.status !== "starting" || this.child === undefined || this.exitSeen) {
				this.protocolFailure("worker_lost");
				return;
			}
			const ready = this.transition("ready");
			if (!ready.ok) {
				this.protocolFailure("worker_persistence_failed");
				return;
			}
			this.armWatchdog();
			this.readyWaiter?.resolve(Result.ok(ready.value));
		}

		if (receiptFrame === undefined) return;
		if (this.deadlineElapsed()) {
			this.protocolFailure(
				"worker_deadline_exceeded",
				"Operation Worker deadline timed out",
			);
			return;
		}
		const receipt = receiptFrame.receipt;
		const status: WorkerLifecycleStatus | undefined =
			receipt.status === "succeeded"
				? "completed"
				: receipt.status === "failed"
					? "failed"
					: receipt.status === "cancelled"
						? "cancelled"
						: undefined;
		if (status === undefined) {
			this.protocolFailure("worker_receipt_invalid");
			return;
		}
		const terminal = this.transition(status, {
			activeOperationId: receipt.operationId,
			receiptId: receipt.workerReceiptId,
			sideEffectState: receipt.sideEffectState,
		});
		if (!terminal.ok) {
			this.protocolFailure("worker_receipt_invalid");
			return;
		}
		this.clearWatchdog();
		this.receiptWaiter?.resolve(Result.ok(receipt));
		this.terminalWaiter?.resolve(true);
	}

	private async sendFrame(frame: OperationWorkerRequestFrame): Promise<ResultValue<void, FoundationError>> {
		const child = this.child;
		if (child === undefined || child.stdin.destroyed || !child.stdin.writable) {
			return Result.err(stableError("worker_lost", "Operation Worker connection is unavailable"));
		}
		const accepted = this.protocol.receiveHostFrame(frame);
		if (!accepted.ok) return Result.err(stableError(accepted.error.code as SupervisorErrorCode, accepted.error.message));
		let line: string;
		try {
			line = serializeWorkerFrameLine(frame);
		} catch {
			return Result.err(stableError("worker_operation_invalid", "Operation Worker request is invalid"));
		}
		const bytes = Buffer.byteLength(line, "utf8");
		if (
			bytes > WORKER_PROTOCOL_MAX_FRAME_BYTES ||
			child.stdin.writableLength + bytes >
				(this.config.maxPendingWriteBytes ?? DEFAULT_MAX_PENDING_WRITE_BYTES)
		) {
			return Result.err(stableError("worker_operation_invalid", "Operation Worker backpressure limit was exceeded"));
		}
		try {
			if (child.stdin.write(line, "utf8")) return Result.ok(undefined);
		} catch {
			return Result.err(stableError("worker_lost", "Operation Worker connection is unavailable"));
		}
		const drained = deferred<void>();
		child.stdin.once("drain", drained.resolve);
		const result = await this.withTimeout(
			drained.promise,
			this.config.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
		);
		child.stdin.removeListener("drain", drained.resolve);
		return result.timedOut
			? Result.err(stableError("worker_lost", "Operation Worker backpressure did not drain"))
			: Result.ok(undefined);
	}

	private sendCredentialProjection(
		type: "credential.project" | "credential.renew",
		lease: SafeLeaseProjection,
	): Promise<ResultValue<void, FoundationError>> {
		const workerId = this.lifecycle?.binding.workerId;
		if (workerId === undefined || this.lifecycle === undefined || isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) {
			return Promise.resolve(Result.err(stableError("worker_lost", "Operation Worker is unavailable for credential projection")));
		}
		return this.sendFrame({
			type,
			requestId: this.nextRequestId(type === "credential.project" ? "credential-project" : "credential-renew"),
			workerId,
			lease,
		});
	}

	private transition(
		to: WorkerLifecycleStatus,
		facts: {
			readonly activeOperationId?: string;
			readonly receiptId?: string;
			readonly sideEffectState?: "none" | "unknown" | "side_effect_unknown";
		} = {},
	): ResultValue<WorkerRecord, FoundationError> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_persistence_failed", "Operation Worker lifecycle is unavailable"));
		}
		const applied = applyWorkerTransition(this.lifecycle, {
			schemaVersion: WORKER_SCHEMA_VERSION,
			clientRequestId: this.nextRequestId(`lifecycle-${to}`),
			expectedRevision: this.lifecycle.record.revision,
			binding: this.lifecycle.binding,
			to,
			at: [
				this.timestamp(),
				this.lifecycle.transitions.at(-1)?.at ?? this.lifecycle.record.createdAt,
				this.lifecycle.record.lastHeartbeatAt ?? this.lifecycle.record.createdAt,
			].sort().at(-1)!,
			...facts,
		});
		if (!applied.ok) return applied;
		this.lifecycle = applied.value.state;
		return Result.ok(applied.value.record);
	}

	private markLost(
		code: SupervisorErrorCode,
		message = "Operation Worker lost a trusted terminal outcome",
	): FoundationError {
		const error = stableError(code, message);
		this.clearWatchdog();
		this.discardPendingFrameCommits();
		const status = this.lifecycle?.record.status;
		const readOnlyFailure = this.receiptWaiter !== undefined && this.activeSideEffect === "none";
		if (
			status === "starting" ||
			status === "ready" ||
			status === "running" ||
			status === "cancelling"
		) {
			this.transition(readOnlyFailure ? "failed" : "lost", {
				...(this.lifecycle?.record.activeOperationId === undefined
					? {}
					: { activeOperationId: this.lifecycle.record.activeOperationId }),
				sideEffectState: readOnlyFailure ? "none" : "side_effect_unknown",
			});
		}
		this.readyWaiter?.resolve(Result.err(error));
		this.receiptWaiter?.resolve(Result.err(error));
		this.terminalWaiter?.resolve(false);
		return error;
	}

	private protocolFailure(code: SupervisorErrorCode, message?: string): void {
		this.markLost(code, message);
		void this.ensureProcessStoppedAndCleaned();
	}

	private armWatchdog(): void {
		this.clearWatchdog();
		if (this.lifecycle === undefined || isWorkerExecutionTerminalStatus(this.lifecycle.record.status)) return;
		const timeoutMs = Math.min(
			this.config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
			this.remainingDeadlineMs(this.lifecycle.binding),
		);
		this.watchdogTimer = setTimeout(() => {
			if (this.hasTrustedExecutionTerminal()) return;
			const deadlineFailure = this.deadlineOwnsWatchdogExpiry();
			this.protocolFailure(
				deadlineFailure ? "worker_deadline_exceeded" : "worker_lost",
				deadlineFailure
					? "Operation Worker deadline timed out"
					: "Operation Worker heartbeat timed out",
			);
		}, timeoutMs);
		this.watchdogTimer.unref();
	}

	private deadlineElapsed(): boolean {
		const deadlineAt = this.lifecycle?.binding.deadlineAt;
		return deadlineAt !== undefined && deadlineAt <= this.now().getTime();
	}

	private deadlineOwnsWatchdogExpiry(): boolean {
		const deadlineAt = this.lifecycle?.binding.deadlineAt;
		if (deadlineAt === undefined) return false;
		const heartbeatTimeoutMs = this.config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
		// armWatchdog uses min(heartbeat, remaining deadline). If a stale
		// heartbeat-length timer fires while that remaining window is already
		// shorter than the heartbeat bound, expiry is a deadline failure.
		return this.now().getTime() + heartbeatTimeoutMs >= deadlineAt;
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer === undefined) return;
		clearTimeout(this.watchdogTimer);
		this.watchdogTimer = undefined;
	}

	private remainingDeadlineMs(binding: WorkerBinding): number {
		return binding.deadlineAt === undefined
			? Number.MAX_SAFE_INTEGER
			: Math.max(1, binding.deadlineAt - this.now().getTime());
	}

	private async stopProcessTree(): Promise<void> {
		const child = this.child;
		if (child === undefined || this.exitSeen) return;
		this.closing = true;
		const pid = child.pid;
		if (pid !== undefined) killProcessTree(pid);
		await wait(0);
	}

	private ensureProcessStoppedAndCleaned(): Promise<void> {
		this.processStopPromise ??= this.stopAndCleanupProcess();
		return this.processStopPromise;
	}

	private async stopAndCleanupProcess(): Promise<void> {
		const child = this.child;
		if (child === undefined) return;
		await this.stopProcessTree();
		let exited = this.exitSeen;
		if (!exited && this.exitWaiter !== undefined) {
			exited = !(await this.withTimeout(
				this.exitWaiter.promise,
				this.config.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
			)).timedOut;
		}
		if (!exited && child.pid !== undefined) {
			killProcessTree(child.pid);
			if (this.exitWaiter !== undefined) {
				exited = !(await this.withTimeout(
					this.exitWaiter.promise,
					this.config.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
				)).timedOut;
			}
		}
		if (!exited && child.pid !== undefined) this.quarantinedValue = true;
		this.cleanupProcess();
	}

	private failStart(): FoundationError {
		const failure = stableError("worker_start_failed", "Operation Worker failed to start");
		if (this.lifecycle?.record.status === "starting") {
			this.transition("failed", { sideEffectState: "none" });
		}
		this.readyWaiter?.resolve(Result.err(failure));
		this.terminalWaiter?.resolve(false);
		return failure;
	}

	private discardPendingFrameCommits(): void {
		this.pendingReadyFrame = undefined;
		this.pendingReceiptFrame = undefined;
		if (this.frameCommit === undefined) return;
		clearImmediate(this.frameCommit);
		this.frameCommit = undefined;
	}

	private cleanupProcess(): void {
		this.clearWatchdog();
		this.discardPendingFrameCommits();
		const child = this.child;
		if (child !== undefined) {
			child.stdin.removeListener("error", this.onStdinError);
			child.stdout.removeListener("data", this.onStdoutData);
			child.stdout.removeListener("end", this.onStdoutEnd);
			child.stderr.removeListener("data", this.onStderrData);
			child.removeListener("error", this.onProcessError);
			child.removeListener("exit", this.onProcessExit);
			child.removeListener("close", this.onProcessExit);
			child.on("error", (error: Error) => {
				void error;
			});
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		}
		this.child = undefined;
		this.stdoutBuffer = "";
	}

	private hasTrustedExecutionTerminal(): boolean {
		return this.lifecycle !== undefined && isWorkerExecutionTerminalStatus(this.lifecycle.record.status);
	}

	private isWorkerEvent(frame: OperationWorkerRequestFrame | OperationWorkerEventFrame): frame is OperationWorkerEventFrame {
		return frame.type === "ready" ||
			frame.type === "heartbeat" ||
			frame.type === "operation.started" ||
			frame.type === "operation.data" ||
			frame.type === "operation.completed" ||
			frame.type === "receipt" ||
			frame.type === "error" ||
			frame.type === "pong";
	}

	private nextRequestId(prefix: string): string {
		this.requestSequence += 1;
		return `${prefix}-${this.requestSequence}`;
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	private async withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<TimedWait<T>> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<TimedWait<T>>((resolve) => {
			timer = setTimeout(() => resolve({ timedOut: true }), milliseconds);
			timer.unref();
		});
		const result = await Promise.race([
			promise.then((value): TimedWait<T> => ({ timedOut: false, value })),
			timeout,
		]);
		if (timer !== undefined) clearTimeout(timer);
		return result;
	}
}

export const WorkerSupervisor = OperationWorkerSupervisor;
