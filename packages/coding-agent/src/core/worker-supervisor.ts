/**
 * Host-side lifecycle authority for one local Operation Worker process.
 *
 * Preflight is read-only and returns an activation token. Only activate may
 * create the fixed trusted child. Process details and private protocol data
 * never enter WorkerBindingV1, WorkerRecordV1, or Foundation errors.
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
	type Result as ResultValue,
	type SandboxOperationRequestV1,
	type WorkerReceiptV1,
} from "@aos-agent/agent-core";
import {
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	WorkerProtocolSessionV1,
	parseWorkerFrameV1,
	serializeWorkerFrameLineV1,
	type WorkerCancelReasonV1,
	type WorkerEventFrameV1,
	type WorkerRequestFrameV1,
} from "./worker-protocol.ts";
import {
	WORKER_SCHEMA_VERSION,
	applyWorkerHeartbeatV1,
	applyWorkerTransitionV1,
	createWorkerLifecycleV1,
	isWorkerExecutionTerminalStatusV1,
	isWorkerReclaimTerminalStatusV1,
	validateWorkerBindingV1,
	validateWorkerLifecycleStateV1,
	type WorkerBindingV1,
	type WorkerLifecycleStateV1,
	type WorkerLifecycleStatusV1,
	type WorkerRecordV1,
} from "./worker.ts";
import {
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.ts";

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

export interface WorkerSupervisorConfigV1 {
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

export interface WorkerSupervisorPreflightInputV1 {
	readonly binding: WorkerBindingV1;
	readonly runAccepted: boolean;
}

/** Opaque, single-use activation seam returned only by successful preflight. */
export interface WorkerActivationPlanV1 {
	readonly schemaVersion: 1;
	readonly binding: WorkerBindingV1;
}

export interface WorkerSupervisorSnapshotV1 {
	readonly record?: WorkerRecordV1;
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

function cloneBinding(binding: WorkerBindingV1): WorkerBindingV1 {
	return Object.freeze({
		...binding,
		capabilitySummary: Object.freeze([...binding.capabilitySummary]),
		credentialTargetRefs: Object.freeze([...binding.credentialTargetRefs]),
	});
}

function cloneLifecycleState(state: WorkerLifecycleStateV1): WorkerLifecycleStateV1 {
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

export class WorkerSupervisorV1 {
	private readonly config: WorkerSupervisorConfigV1;
	private readonly environment: Readonly<Record<string, string>>;
	private readonly now: () => Date;
	private readonly protocol = new WorkerProtocolSessionV1();
	private activationPlan?: WorkerActivationPlanV1;
	private activationAttempted = false;
	private child?: ChildProcessWithoutNullStreams;
	private lifecycle?: WorkerLifecycleStateV1;
	private stdoutBuffer = "";
	private requestSequence = 0;
	private readyWaiter?: Deferred<ResultValue<WorkerRecordV1, FoundationError>>;
	private receiptWaiter?: Deferred<ResultValue<WorkerReceiptV1, FoundationError>>;
	private terminalWaiter?: Deferred<boolean>;
	private exitWaiter?: Deferred<void>;
	private watchdogTimer?: NodeJS.Timeout;
	private closing = false;
	private exitSeen = false;
	private reclaimFailure = false;
	private recoveredWithoutProcess = false;
	private quarantinedValue = false;
	private reclaimPromise?: Promise<ResultValue<WorkerRecordV1, FoundationError>>;

	constructor(config: WorkerSupervisorConfigV1) {
		this.config = Object.freeze({ ...config, capabilities: Object.freeze([...config.capabilities]) });
		this.environment = Object.freeze({ ...(config.environment ?? {}) });
		this.now = config.now ?? (() => new Date());
	}

	get snapshot(): WorkerSupervisorSnapshotV1 {
		return Object.freeze({
			...(this.lifecycle === undefined ? {} : { record: this.lifecycle.record }),
			hasLiveProcess: this.child !== undefined && !this.exitSeen,
			quarantined: this.quarantinedValue,
		});
	}

	get lifecycleState(): WorkerLifecycleStateV1 | undefined {
		return this.lifecycle;
	}

	preflight(input: WorkerSupervisorPreflightInputV1): ResultValue<WorkerActivationPlanV1, FoundationError> {
		if (this.activationAttempted || this.activationPlan !== undefined || this.lifecycle !== undefined) {
			return Result.err(stableError("worker_conflict", "Operation Worker activation cannot be reused"));
		}
		if (!input.runAccepted) {
			return Result.err(stableError("worker_unavailable", "Operation Worker requires an accepted Run"));
		}
		if (!validateWorkerBindingV1(input.binding)) {
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
		const plan: WorkerActivationPlanV1 = Object.freeze({
			schemaVersion: WORKER_SCHEMA_VERSION,
			binding: cloneBinding(input.binding),
		});
		this.activationPlan = plan;
		return Result.ok(plan);
	}

	async activate(plan: WorkerActivationPlanV1): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		if (this.activationAttempted || plan !== this.activationPlan) {
			return Result.err(stableError("worker_conflict", "Operation Worker activation token is invalid"));
		}
		this.activationAttempted = true;
		this.activationPlan = undefined;
		const created = createWorkerLifecycleV1(plan.binding, this.timestamp());
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
		if (child.pid === undefined) {
			this.transition("failed", { sideEffectState: "none" });
			this.cleanupProcess();
			return Result.err(stableError("worker_start_failed", "Operation Worker failed to start"));
		}
		trackDetachedChildPid(child.pid);
		this.attachProcessListeners(child);
		this.readyWaiter = deferred();
		this.exitWaiter = deferred();

		const initialize: WorkerRequestFrameV1 = {
			type: "initialize",
			requestId: this.nextRequestId("initialize"),
			binding: plan.binding,
		};
		const sent = await this.sendFrame(initialize);
		if (!sent.ok) {
			this.markLost(sent.error.code === "worker_operation_invalid" ? "worker_operation_invalid" : "worker_lost");
			return Result.err(sent.error);
		}

		const timeoutMs = Math.min(
			this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			this.remainingDeadlineMs(plan.binding),
		);
		const ready = await this.withTimeout(this.readyWaiter.promise, timeoutMs);
		if (!ready.timedOut) return ready.value;

		const failure = stableError("worker_start_failed", "Operation Worker readiness timed out");
		if (this.lifecycle?.record.status === "starting") {
			this.transition("failed", { sideEffectState: "none" });
		}
		this.readyWaiter.resolve(Result.err(failure));
		await this.stopProcessTree();
		return Result.err(failure);
	}

	async execute(request: SandboxOperationRequestV1): Promise<ResultValue<WorkerReceiptV1, FoundationError>> {
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
		const frame: WorkerRequestFrameV1 = {
			type: "execute",
			requestId: this.nextRequestId("execute"),
			workerId: this.lifecycle.binding.workerId,
			operationId: request.operationId,
			request,
		};
		const sent = await this.sendFrame(frame);
		if (!sent.ok) {
			this.markLost("worker_operation_invalid");
			return Result.err(sent.error);
		}
		this.armWatchdog();
		return this.receiptWaiter.promise;
	}

	async cancel(
		reason: WorkerCancelReasonV1 = "cancel",
		operationId?: string,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.lifecycle === undefined || this.child === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status)) return Result.ok(undefined);
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
		this.markLost("worker_cancel_failed");
		await this.reclaim();
		return Result.err(stableError("worker_cancel_failed", "Operation Worker cancellation timed out"));
	}

	async terminate(reason: WorkerCancelReasonV1 = "shutdown"): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		if (
			this.lifecycle !== undefined &&
			!isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status) &&
			this.lifecycle.record.status !== "reclaiming" &&
			!isWorkerReclaimTerminalStatusV1(this.lifecycle.record.status)
		) {
			await this.cancel(reason, this.lifecycle.record.activeOperationId);
		}
		return this.reclaim();
	}

	dispose(): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		return this.terminate("shutdown");
	}

	reclaim(): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		this.reclaimPromise ??= this.performReclaim();
		return this.reclaimPromise;
	}

	/** Restore safe facts only. No process, handle, lease, or protocol session is recreated. */
	recover(state: WorkerLifecycleStateV1): ResultValue<WorkerRecordV1, FoundationError> {
		if (this.activationAttempted || this.lifecycle !== undefined || !validateWorkerLifecycleStateV1(state)) {
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

	private async performReclaim(): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_not_found", "Operation Worker was not activated"));
		}
		if (isWorkerReclaimTerminalStatusV1(this.lifecycle.record.status)) {
			return Result.ok(this.lifecycle.record);
		}
		if (!isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status)) {
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
		this.protocolFailure("worker_lost");
	};

	private readonly onProcessExit = (): void => {
		this.exitSeen = true;
		const pid = this.child?.pid;
		if (pid !== undefined) untrackDetachedChildPid(pid);
		this.exitWaiter?.resolve();
		if (!this.closing && !this.hasTrustedExecutionTerminal()) this.protocolFailure("worker_lost");
	};

	private handleWorkerLine(line: string): void {
		const parsed = parseWorkerFrameV1(line);
		if (!parsed.ok || !this.isWorkerEvent(parsed.value)) {
			this.protocolFailure("worker_operation_invalid");
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

	private handleWorkerEvent(frame: WorkerEventFrameV1): void {
		if (frame.type === "ready") {
			const ready = this.transition("ready");
			if (!ready.ok) {
				this.protocolFailure("worker_persistence_failed");
				return;
			}
			this.armWatchdog();
			this.readyWaiter?.resolve(Result.ok(ready.value));
			return;
		}
		if (frame.type === "heartbeat") {
			if (this.lifecycle === undefined || isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status)) return;
			const heartbeatAt = [
				frame.at,
				this.lifecycle.transitions.at(-1)?.at ?? this.lifecycle.record.createdAt,
				this.lifecycle.record.lastHeartbeatAt ?? this.lifecycle.record.createdAt,
			].sort().at(-1)!;
			const folded = applyWorkerHeartbeatV1(this.lifecycle, {
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

		const receipt = frame.receipt;
		const status: WorkerLifecycleStatusV1 | undefined =
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

	private async sendFrame(frame: WorkerRequestFrameV1): Promise<ResultValue<void, FoundationError>> {
		const child = this.child;
		if (child === undefined || child.stdin.destroyed || !child.stdin.writable) {
			return Result.err(stableError("worker_lost", "Operation Worker connection is unavailable"));
		}
		const accepted = this.protocol.receiveHostFrame(frame);
		if (!accepted.ok) return Result.err(stableError(accepted.error.code as SupervisorErrorCode, accepted.error.message));
		let line: string;
		try {
			line = serializeWorkerFrameLineV1(frame);
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

	private transition(
		to: WorkerLifecycleStatusV1,
		facts: {
			readonly activeOperationId?: string;
			readonly receiptId?: string;
			readonly sideEffectState?: "none" | "unknown" | "side_effect_unknown";
		} = {},
	): ResultValue<WorkerRecordV1, FoundationError> {
		if (this.lifecycle === undefined) {
			return Result.err(stableError("worker_persistence_failed", "Operation Worker lifecycle is unavailable"));
		}
		const applied = applyWorkerTransitionV1(this.lifecycle, {
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

	private markLost(code: SupervisorErrorCode): FoundationError {
		const error = stableError(code, "Operation Worker lost a trusted terminal outcome");
		this.clearWatchdog();
		const status = this.lifecycle?.record.status;
		if (
			status === "starting" ||
			status === "ready" ||
			status === "running" ||
			status === "cancelling"
		) {
			this.transition("lost", {
				...(this.lifecycle?.record.activeOperationId === undefined
					? {}
					: { activeOperationId: this.lifecycle.record.activeOperationId }),
				sideEffectState: "side_effect_unknown",
			});
		}
		this.readyWaiter?.resolve(Result.err(error));
		this.receiptWaiter?.resolve(Result.err(error));
		this.terminalWaiter?.resolve(false);
		return error;
	}

	private protocolFailure(code: SupervisorErrorCode): void {
		this.markLost(code);
		void this.stopProcessTree();
	}

	private armWatchdog(): void {
		this.clearWatchdog();
		if (this.lifecycle === undefined || isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status)) return;
		const timeoutMs = Math.min(
			this.config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
			this.remainingDeadlineMs(this.lifecycle.binding),
		);
		this.watchdogTimer = setTimeout(() => {
			const deadlineElapsed =
				this.lifecycle?.binding.deadlineAt !== undefined &&
				this.lifecycle.binding.deadlineAt <= this.now().getTime();
			this.protocolFailure(deadlineElapsed ? "worker_deadline_exceeded" : "worker_lost");
		}, timeoutMs);
		this.watchdogTimer.unref();
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer === undefined) return;
		clearTimeout(this.watchdogTimer);
		this.watchdogTimer = undefined;
	}

	private remainingDeadlineMs(binding: WorkerBindingV1): number {
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

	private cleanupProcess(): void {
		this.clearWatchdog();
		const child = this.child;
		if (child !== undefined) {
			child.stdin.removeListener("error", this.onStdinError);
			child.stdout.removeListener("data", this.onStdoutData);
			child.stdout.removeListener("end", this.onStdoutEnd);
			child.stderr.removeListener("data", this.onStderrData);
			child.removeListener("error", this.onProcessError);
			child.removeListener("exit", this.onProcessExit);
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		}
		this.child = undefined;
		this.stdoutBuffer = "";
	}

	private hasTrustedExecutionTerminal(): boolean {
		return this.lifecycle !== undefined && isWorkerExecutionTerminalStatusV1(this.lifecycle.record.status);
	}

	private isWorkerEvent(frame: WorkerRequestFrameV1 | WorkerEventFrameV1): frame is WorkerEventFrameV1 {
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

export const WorkerSupervisor = WorkerSupervisorV1;
