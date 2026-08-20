import { Result, type FoundationError, type Result as ResultValue } from "@aos-agent/agent-core";
import {
	WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES,
	formatWorkerStderrDiagnosticV1,
	serializeWorkerFrameLineV1,
	WorkerProtocolSessionV1,
	type WorkerEventFrameV1,
	type WorkerRequestFrameV1,
} from "../../src/core/worker-protocol.ts";
import type { WorkerBindingV1 } from "../../src/core/worker.ts";

export type FakeWorkerTransportModeV1 = "ready" | "slow" | "cancel_ack" | "receipt" | "disconnect" | "malformed" | "oversized_data";

export class FakeWorkerProtocolTransportV1 {
	private readonly session: WorkerProtocolSessionV1;
	private readonly binding: WorkerBindingV1;
	private readonly mode: FakeWorkerTransportModeV1;
	private readonly stdoutLines: string[] = [];

	constructor(binding: WorkerBindingV1, mode: FakeWorkerTransportModeV1 = "ready") {
		this.binding = binding;
		this.mode = mode;
		this.session = new WorkerProtocolSessionV1();
	}

	get state() {
		return this.session.state;
	}

	send(frame: WorkerRequestFrameV1): ResultValue<readonly string[], FoundationError> {
		const accepted = this.session.receiveHostFrame(frame);
		if (!accepted.ok) return accepted;
		if (frame.type === "initialize") {
			if (this.mode === "disconnect") return Result.err(this.session.disconnect());
			if (this.mode === "malformed") {
				this.stdoutLines.push("{malformed worker frame");
				return Result.ok(this.takeStdout());
			}
			this.emit({
				type: "ready",
				requestId: frame.requestId,
				workerId: this.binding.workerId,
				providerId: this.binding.providerId,
				requestFingerprint: this.binding.requestFingerprint,
				capabilities: [...this.binding.capabilitySummary],
			});
			return Result.ok(this.takeStdout());
		}
		if (frame.type === "execute") {
			if (this.mode === "slow") return Result.ok(this.takeStdout());
			if (this.mode === "disconnect") return Result.err(this.session.disconnect());
			this.emit({ type: "operation.started", requestId: frame.requestId, workerId: frame.workerId, operationId: frame.operationId, at: "2026-08-21T00:00:01.000Z" });
			if (this.mode === "oversized_data") {
				this.emit({
					type: "operation.data",
					requestId: frame.requestId,
					workerId: frame.workerId,
					operationId: frame.operationId,
					stream: "content",
					data: "x".repeat(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES + 64),
				});
				return Result.ok(this.takeStdout());
			}
			if (this.mode === "cancel_ack") return Result.ok(this.takeStdout());
			if (this.mode === "receipt" || this.mode === "ready") {
				this.emit({
					type: "operation.completed",
					requestId: frame.requestId,
					workerId: frame.workerId,
					operationId: frame.operationId,
					result: { schemaVersion: 1, operationId: frame.operationId, ok: true, sideEffectState: "none" },
				});
				this.emitReceiptForExecute(frame);
			}
			return Result.ok(this.takeStdout());
		}
		if (frame.type === "cancel" && this.mode === "cancel_ack" && frame.operationId !== undefined) {
			this.emit({
				type: "error",
				requestId: frame.requestId,
				workerId: frame.workerId,
				code: "worker_cancel_failed",
			});
		}
		return Result.ok(this.takeStdout());
	}

	stderr(diagnostic: string): string {
		return formatWorkerStderrDiagnosticV1(diagnostic);
	}

	disconnect(): FoundationError {
		return this.session.disconnect();
	}

	private emit(frame: WorkerEventFrameV1): void {
		const accepted = this.session.receiveWorkerFrame(frame);
		if (!accepted.ok) throw accepted.error;
		this.stdoutLines.push(serializeWorkerFrameLineV1(frame));
	}

	private emitReceiptForExecute(frame: Extract<WorkerRequestFrameV1, { type: "execute" }>): void {
		this.emitReceipt({ requestId: frame.requestId, operationId: frame.operationId, taskId: frame.request.taskId, dispatchId: frame.request.dispatchId, attemptId: frame.request.attemptId });
	}

	private emitReceipt(input: { readonly requestId: string; readonly operationId: string; readonly taskId?: string; readonly dispatchId?: string; readonly attemptId?: string }): void {
		this.emit({
			type: "receipt",
			requestId: input.requestId,
			receipt: {
				schemaVersion: 1,
				workerReceiptId: `receipt-${input.operationId}`,
				sandboxProviderId: this.binding.providerId,
				operationId: input.operationId,
				...(input.taskId === undefined ? {} : { taskId: input.taskId }),
				...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
				...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
				status: "succeeded",
				sideEffectState: "none",
				provenance: {
					producerKind: "operation_worker",
					providerId: this.binding.providerId,
					producedAt: "2026-08-21T00:00:02.000Z",
					correlation: { sessionId: this.binding.sessionId, laneId: this.binding.laneId, operationId: input.operationId, ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }), ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }), revision: 0 },
				},
				startedAt: "2026-08-21T00:00:01.000Z",
				completedAt: "2026-08-21T00:00:02.000Z",
			},
		});
	}

	private takeStdout(): readonly string[] {
		const lines = [...this.stdoutLines];
		this.stdoutLines.length = 0;
		return lines;
	}
}

export const FakeWorkerTransportV1 = FakeWorkerProtocolTransportV1;
