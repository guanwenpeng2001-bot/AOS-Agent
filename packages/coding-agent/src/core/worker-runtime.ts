import {
	canonicalFoundationJson,
	validateFoundationProviderCapability,
	validateWorkerReceiptForProvider,
	type ExecutionCorrelation,
	type FoundationError,
	type Result,
	type SandboxOperationProvider,
	type WorkerReceipt,
} from "@aos-agent/agent-core";
import {
	WorkerProtocolSessionV1,
	formatWorkerStderrDiagnosticV1,
	parseWorkerFrameV1,
	type SafeLeaseProjectionV1,
	type SafeLeaseReferenceV1,
	type WorkerEventFrameV1,
	type WorkerRequestFrameV1,
} from "./worker-protocol.ts";
import type { WorkerBindingV1 } from "./worker.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** Credential projection is an optional operation-worker capability, never a Host credential store. */
export interface WorkerRuntimeSandboxOperationProviderV1 extends SandboxOperationProvider {
	projectCredential?(lease: SafeLeaseProjectionV1): Promise<Result<void, FoundationError>>;
	renewCredential?(lease: SafeLeaseProjectionV1): Promise<Result<void, FoundationError>>;
	revokeCredential?(lease: SafeLeaseReferenceV1): Promise<Result<void, FoundationError>>;
}

export interface WorkerRuntimeOptionsV1 {
	readonly provider: WorkerRuntimeSandboxOperationProviderV1;
	readonly emit: (frame: WorkerEventFrameV1) => void | Promise<void>;
	readonly diagnostic?: (line: string) => void;
	readonly now?: () => string;
	readonly heartbeatIntervalMs?: number;
	readonly onClosed?: () => void;
}

/**
 * Trusted child-side state machine for the private Host/Worker JSONL protocol.
 * It delegates only bounded operation and credential calls to one injected
 * operation provider and has no task, attempt, agent, model, or settlement authority.
 */
export class WorkerRuntimeV1 {
	private readonly provider: WorkerRuntimeSandboxOperationProviderV1;
	private readonly emitFrame: (frame: WorkerEventFrameV1) => void | Promise<void>;
	private readonly diagnosticWriter: ((line: string) => void) | undefined;
	private readonly now: () => string;
	private readonly heartbeatIntervalMs: number;
	private readonly onClosed: (() => void) | undefined;
	private readonly protocol = new WorkerProtocolSessionV1();
	private readonly pendingOperations = new Set<Promise<void>>();
	private outputTail: Promise<void> = Promise.resolve();
	private bindingValue?: WorkerBindingV1;
	private heartbeatTimer?: NodeJS.Timeout;
	private heartbeatSequence = 0;
	private closedValue = false;

	constructor(options: WorkerRuntimeOptionsV1) {
		this.provider = options.provider;
		this.emitFrame = options.emit;
		this.diagnosticWriter = options.diagnostic;
		this.now = options.now ?? (() => new Date().toISOString());
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.onClosed = options.onClosed;
		if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 0) {
			throw new RangeError("heartbeatIntervalMs must be a non-negative safe integer");
		}
	}

	get closed(): boolean {
		return this.closedValue;
	}

	get binding(): WorkerBindingV1 | undefined {
		return this.bindingValue;
	}

	async receiveLine(line: string): Promise<void> {
		if (this.closedValue) return;
		const parsed = parseWorkerFrameV1(line);
		if (!parsed.ok) {
			this.failClosed("invalid worker request frame");
			return;
		}
		await this.receiveFrame(parsed.value);
	}

	async receiveFrame(value: unknown): Promise<void> {
		if (this.closedValue) return;
		const accepted = this.protocol.receiveHostFrame(value);
		if (!accepted.ok) {
			this.failClosed("worker protocol violation");
			return;
		}
		const frame = accepted.value.frame as WorkerRequestFrameV1;
		switch (frame.type) {
			case "initialize":
				await this.initialize(frame);
				return;
			case "execute":
				await this.execute(frame);
				return;
			case "credential.project":
				await this.credential(frame, "projectCredential");
				return;
			case "credential.renew":
				await this.credential(frame, "renewCredential");
				return;
			case "credential.revoke":
				await this.revokeCredential(frame);
				return;
			case "cancel":
				await this.cancel(frame);
				return;
			case "reclaim":
				await this.reclaim(frame);
				return;
			case "ping":
				await this.emit({ type: "pong", requestId: frame.requestId, workerId: frame.workerId, at: this.now() });
		}
	}

	async emitHeartbeat(): Promise<void> {
		const binding = this.bindingValue;
		const phase = this.protocol.state.phase;
		if (this.closedValue || binding === undefined || (phase !== "ready" && phase !== "running" && phase !== "cancelling")) return;
		this.heartbeatSequence += 1;
		await this.emit({ type: "heartbeat", workerId: binding.workerId, sequence: this.heartbeatSequence, at: this.now() });
	}

	/** Wait for provider work already accepted by the runtime and all queued output. */
	async waitForIdle(): Promise<void> {
		await Promise.all([...this.pendingOperations]);
		await this.outputTail;
	}

	/** Mark an input transport failure without reflecting untrusted input to stdout/stderr. */
	failInput(): void {
		this.failClosed("worker input transport failed");
	}

	close(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.protocol.disconnect();
		this.onClosed?.();
	}

	private async initialize(frame: Extract<WorkerRequestFrameV1, { type: "initialize" }>): Promise<void> {
		this.bindingValue = frame.binding;
		if (this.provider.schemaVersion !== 1 || this.provider.providerClass !== "operation_worker" || this.provider.providerId !== frame.binding.providerId) {
			await this.requestError(frame.requestId, "worker_binding_invalid", "operation provider identity mismatch", true);
			return;
		}
		try {
			const capabilities = await this.provider.capabilities();
			const capabilityIds: string[] = [];
			const seen = new Set<string>();
			for (const capability of capabilities) {
				const checked = validateFoundationProviderCapability(capability);
				if (!checked.ok || seen.has(checked.value.id)) {
					await this.requestError(frame.requestId, "sandbox_capability_insufficient", "operation provider capability mismatch", true);
					return;
				}
				seen.add(checked.value.id);
				capabilityIds.push(checked.value.id);
			}
			if (!sameStrings(capabilityIds, frame.binding.capabilitySummary)) {
				await this.requestError(frame.requestId, "sandbox_capability_insufficient", "operation provider capability mismatch", true);
				return;
			}
			await this.emit({
				type: "ready",
				requestId: frame.requestId,
				workerId: frame.binding.workerId,
				providerId: frame.binding.providerId,
				requestFingerprint: frame.binding.requestFingerprint,
				capabilities: capabilityIds,
			});
			this.startHeartbeat();
		} catch {
			await this.requestError(frame.requestId, "worker_start_failed", "operation provider initialization failed", true);
		}
	}

	private async execute(frame: Extract<WorkerRequestFrameV1, { type: "execute" }>): Promise<void> {
		const binding = this.bindingValue;
		if (binding === undefined) {
			this.failClosed("execute without worker binding");
			return;
		}
		await this.emit({ type: "operation.started", requestId: frame.requestId, workerId: frame.workerId, operationId: frame.operationId, at: this.now() });
		if (this.closedValue) return;
		const correlation = operationCorrelation(binding, frame.request);
		let pending: Promise<void>;
		pending = this.runOperation(frame, correlation).finally(() => this.pendingOperations.delete(pending));
		this.pendingOperations.add(pending);
	}

	private async runOperation(frame: Extract<WorkerRequestFrameV1, { type: "execute" }>, correlation: ExecutionCorrelation): Promise<void> {
		try {
			const result = await this.provider.start(frame.request, { correlation });
			if (this.closedValue) return;
			if (!result.ok) {
				await this.requestError(frame.requestId, "worker_start_failed", "operation provider rejected execution");
				return;
			}
			const receipt = this.validReceipt(result.value, correlation, frame.request);
			if (receipt === undefined) {
				await this.requestError(frame.requestId, "worker_receipt_invalid", "operation provider returned an invalid receipt", true);
				return;
			}
			await this.emit({
				type: "operation.completed",
				requestId: frame.requestId,
				workerId: frame.workerId,
				operationId: frame.operationId,
				result: {
					schemaVersion: 1,
					operationId: receipt.operationId,
					ok: receipt.status === "succeeded",
					sideEffectState: receipt.sideEffectState,
					...(receipt.artifacts === undefined ? {} : { artifacts: receipt.artifacts }),
					...(receipt.error === undefined ? {} : { error: receipt.error }),
				},
			});
			if (!this.closedValue) await this.emit({ type: "receipt", requestId: frame.requestId, receipt });
		} catch {
			if (!this.closedValue) await this.requestError(frame.requestId, "worker_start_failed", "operation provider execution failed");
		}
	}

	private validReceipt(receipt: WorkerReceipt, correlation: ExecutionCorrelation, request: Extract<WorkerRequestFrameV1, { type: "execute" }>['request']): WorkerReceipt | undefined {
		const checked = validateWorkerReceiptForProvider(receipt, { providerId: this.provider.providerId, providerClass: "operation_worker" });
		if (!checked.ok || checked.value.operationId !== request.operationId) return undefined;
		for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
			if (checked.value[field] !== request[field]) return undefined;
		}
		try {
			return checked.value.provenance.correlation !== undefined && canonicalFoundationJson(checked.value.provenance.correlation) === canonicalFoundationJson(correlation)
				? checked.value
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async credential(
		frame: Extract<WorkerRequestFrameV1, { type: "credential.project" | "credential.renew" }>,
		method: "projectCredential" | "renewCredential",
	): Promise<void> {
		const operation = this.provider[method];
		if (operation === undefined) {
			await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target unavailable");
			return;
		}
		try {
			const result = await operation.call(this.provider, frame.lease);
			if (!result.ok) await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target rejected projection");
		} catch {
			await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target failed");
		}
	}

	private async revokeCredential(frame: Extract<WorkerRequestFrameV1, { type: "credential.revoke" }>): Promise<void> {
		const operation = this.provider.revokeCredential;
		if (operation === undefined) {
			await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target unavailable");
			return;
		}
		try {
			const result = await operation.call(this.provider, frame.leaseRef);
			if (!result.ok) await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target rejected revocation");
		} catch {
			await this.requestError(frame.requestId, "task_credential_target_unavailable", "credential target failed");
		}
	}

	private async cancel(frame: Extract<WorkerRequestFrameV1, { type: "cancel" }>): Promise<void> {
		const operationId = frame.operationId ?? this.protocol.state.operations.find((operation) => !operation.terminal)?.operationId;
		if (operationId === undefined) {
			await this.requestError(frame.requestId, "worker_cancel_failed", "worker has no cancellable operation");
			return;
		}
		try {
			const result = await this.provider.cancel(operationId);
			if (!result.ok) await this.requestError(frame.requestId, "worker_cancel_failed", "operation provider rejected cancellation");
			// A successful provider call deliberately emits no terminal frame: the
			// cancellation acknowledgement does not prove side-effect closure.
		} catch {
			await this.requestError(frame.requestId, "worker_cancel_failed", "operation provider cancellation failed");
		}
	}

	private async reclaim(frame: Extract<WorkerRequestFrameV1, { type: "reclaim" }>): Promise<void> {
		try {
			await this.provider.dispose();
			this.close();
		} catch {
			await this.requestError(frame.requestId, "worker_reclaim_failed", "operation provider reclaim failed");
			this.close();
		}
	}

	private async requestError(requestId: string, code: string, diagnostic: string, close = false): Promise<void> {
		this.writeDiagnostic(diagnostic);
		const binding = this.bindingValue;
		if (binding !== undefined && !this.closedValue) await this.emit({ type: "error", requestId, workerId: binding.workerId, code });
		if (close) this.close();
	}

	private emit(frame: WorkerEventFrameV1): Promise<void> {
		if (this.closedValue) return Promise.resolve();
		// This state-machine transition serializes the complete frame and applies
		// WORKER_PROTOCOL_MAX_FRAME_BYTES before the transport callback can run.
		// Per-field bounds such as WORKER_PROTOCOL_MAX_RESULT_DATA_BYTES never
		// bypass that gate.
		const accepted = this.protocol.receiveWorkerFrame(frame);
		if (!accepted.ok) {
			this.failClosed("worker emitted an invalid protocol frame");
			return Promise.resolve();
		}
		const operation = this.outputTail.then(() => this.emitFrame(accepted.value.frame as WorkerEventFrameV1));
		this.outputTail = operation.catch(() => this.failClosed("worker output transport failed"));
		return operation.catch(() => undefined);
	}

	private startHeartbeat(): void {
		if (this.heartbeatIntervalMs === 0 || this.heartbeatTimer !== undefined || this.closedValue) return;
		this.heartbeatTimer = setInterval(() => {
			void this.emitHeartbeat();
		}, this.heartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}

	private failClosed(diagnostic: string): void {
		this.writeDiagnostic(diagnostic);
		this.close();
	}

	private writeDiagnostic(value: string): void {
		try {
			this.diagnosticWriter?.(formatWorkerStderrDiagnosticV1(value));
		} catch {
			// Diagnostic transport is best effort and never changes protocol state.
		}
	}
}

export const WorkerRuntime = WorkerRuntimeV1;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function operationCorrelation(binding: WorkerBindingV1, request: Extract<WorkerRequestFrameV1, { type: "execute" }>['request']): ExecutionCorrelation {
	return {
		sessionId: binding.sessionId,
		laneId: binding.laneId,
		revision: 0,
		providerId: binding.providerId,
		operationId: request.operationId,
		...(binding.runId === undefined ? {} : { runId: binding.runId }),
		...(request.bindingId === undefined ? {} : { bindingId: request.bindingId }),
		...(request.bindingEpochId === undefined ? {} : { bindingEpochId: request.bindingEpochId }),
		...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
		...(request.taskId === undefined ? {} : { taskId: request.taskId }),
		...(request.dispatchId === undefined ? {} : { dispatchId: request.dispatchId }),
		...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
	};
}
