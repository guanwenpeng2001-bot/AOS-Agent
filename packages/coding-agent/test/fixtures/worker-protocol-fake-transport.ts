import { Result, type FoundationError, type ResultValue } from "../../../agent/src/internal.ts";
import {
	WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES,
	formatWorkerStderrDiagnostic,
	serializeWorkerFrameLine,
	OperationWorkerProtocolSession,
	type OperationWorkerEventFrame,
	type OperationWorkerRequestFrame,
} from "../../src/core/worker/protocol.ts";
import type { WorkerBinding } from "../../src/core/worker/lifecycle.ts";

export type FakeWorkerTransportMode = "ready" | "slow" | "cancel_ack" | "receipt" | "disconnect" | "malformed" | "oversized_data";

export class FakeWorkerProtocolTransport {
	private readonly session: OperationWorkerProtocolSession;
	private readonly binding: WorkerBinding;
	private readonly mode: FakeWorkerTransportMode;
	private readonly stdoutLines: string[] = [];

	constructor(binding: WorkerBinding, mode: FakeWorkerTransportMode = "ready") {
		this.binding = binding;
		this.mode = mode;
		this.session = new OperationWorkerProtocolSession();
	}

	get state() {
		return this.session.state;
	}

	send(frame: OperationWorkerRequestFrame): ResultValue<readonly string[], FoundationError> {
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
		return Result.ok(this.takeStdout());
	}

	heartbeat(sequence: number, at: string): ResultValue<readonly string[], FoundationError> {
		const frame: OperationWorkerEventFrame = { type: "heartbeat", workerId: this.binding.workerId, sequence, at };
		const accepted = this.session.receiveWorkerFrame(frame);
		if (!accepted.ok) return accepted;
		this.stdoutLines.push(serializeWorkerFrameLine(frame));
		return Result.ok(this.takeStdout());
	}

	sendHeartbeat(sequence: number, at: string): ResultValue<readonly string[], FoundationError> {
		return this.heartbeat(sequence, at);
	}

	stderr(diagnostic: string): string {
		return formatWorkerStderrDiagnostic(diagnostic);
	}

	disconnect(): FoundationError {
		return this.session.disconnect();
	}

	private emit(frame: OperationWorkerEventFrame): void {
		const accepted = this.session.receiveWorkerFrame(frame);
		if (!accepted.ok) throw accepted.error;
		this.stdoutLines.push(serializeWorkerFrameLine(frame));
	}

	private emitReceiptForExecute(frame: Extract<OperationWorkerRequestFrame, { type: "execute" }>): void {
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

export const FakeWorkerTransport = FakeWorkerProtocolTransport;
