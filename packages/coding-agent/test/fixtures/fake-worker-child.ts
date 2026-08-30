import type { WorkerReceipt } from "../../../agent/src/internal.ts";
import type {
	OperationWorkerEventFrame,
	OperationWorkerRequestFrame,
} from "../../src/core/worker/protocol.ts";
import type { WorkerBinding } from "../../src/core/worker/lifecycle.ts";

const MAX_FRAME_BYTES = 64 * 1024;

let binding: WorkerBinding | undefined;
let activeExecute: Extract<OperationWorkerRequestFrame, { type: "execute" }> | undefined;
let inputBuffer = "";
let heartbeatSequence = 0;
let heartbeatTimer: NodeJS.Timeout | undefined;
let keepAliveTimer: NodeJS.Timeout | undefined;

function emit(frame: OperationWorkerEventFrame): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emitBatch(frames: readonly OperationWorkerEventFrame[]): void {
	process.stdout.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
}

function now(): string {
	return new Date().toISOString();
}

function stopHeartbeat(): void {
	if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
	heartbeatTimer = undefined;
}

function startHeartbeat(oneShot = false): void {
	if (binding === undefined) return;
	const send = () => {
		heartbeatSequence += 1;
		emit({ type: "heartbeat", workerId: binding!.workerId, sequence: heartbeatSequence, at: now() });
	};
	setTimeout(send, 10).unref();
	if (!oneShot) {
		heartbeatTimer = setInterval(send, 20);
	}
}

function receipt(
	frame: Extract<OperationWorkerRequestFrame, { type: "execute" }>,
	status: "succeeded" | "failed" | "cancelled",
	overrides: { readonly taskId?: string } = {},
): WorkerReceipt {
	const currentBinding = binding!;
	const taskId = overrides.taskId ?? frame.request.taskId;
	const sideEffectState = "none" as const;
	const error = status === "failed"
		? { code: "worker_operation_invalid", message: "Operation failed", retryable: false }
		: undefined;
	const startedAt = now();
	return {
		schemaVersion: 1,
		workerReceiptId: `receipt-${frame.operationId}`,
		sandboxProviderId: currentBinding.providerId,
		operationId: frame.operationId,
		...(taskId === undefined ? {} : { taskId }),
		...(frame.request.dispatchId === undefined ? {} : { dispatchId: frame.request.dispatchId }),
		...(frame.request.attemptId === undefined ? {} : { attemptId: frame.request.attemptId }),
		status,
		sideEffectState,
		...(error === undefined ? {} : { error }),
		provenance: {
			producerKind: "operation_worker",
			providerId: currentBinding.providerId,
			producedAt: now(),
			correlation: {
				sessionId: currentBinding.sessionId,
				laneId: currentBinding.laneId,
				operationId: frame.operationId,
				...(taskId === undefined ? {} : { taskId }),
				...(frame.request.dispatchId === undefined ? {} : { dispatchId: frame.request.dispatchId }),
				...(frame.request.attemptId === undefined ? {} : { attemptId: frame.request.attemptId }),
				revision: 0,
			},
		},
		startedAt,
		completedAt: startedAt,
	};
}

function complete(
	frame: Extract<OperationWorkerRequestFrame, { type: "execute" }>,
	status: "succeeded" | "failed" | "cancelled",
	overrides: { readonly taskId?: string } = {},
): void {
	stopHeartbeat();
	const completed: OperationWorkerEventFrame = {
		type: "operation.completed",
		requestId: frame.requestId,
		workerId: frame.workerId,
		operationId: frame.operationId,
		result: {
			schemaVersion: 1,
			operationId: frame.operationId,
			ok: status === "succeeded",
			sideEffectState: "none",
			...(status === "failed"
				? { error: { code: "worker_operation_invalid", message: "Operation failed", retryable: false } }
				: {}),
		},
	};
	const terminal: OperationWorkerEventFrame = {
		type: "receipt",
		requestId: frame.requestId,
		receipt: receipt(frame, status, overrides),
	};
	if (binding?.profileId === "duplicate_terminal") {
		emitBatch([completed, terminal, completed]);
		return;
	}
	if (binding?.profileId === "late_heartbeat") {
		heartbeatSequence += 1;
		emitBatch([
			completed,
			terminal,
			{ type: "heartbeat", workerId: binding.workerId, sequence: heartbeatSequence, at: now() },
		]);
		return;
	}
	if (binding?.profileId === "late_heartbeat_cross_worker") {
		heartbeatSequence += 1;
		emitBatch([
			completed,
			terminal,
			{ type: "heartbeat", workerId: "foreign-worker", sequence: heartbeatSequence, at: now() },
		]);
		return;
	}
	emitBatch([completed, terminal]);
}

function ready(frame: Extract<OperationWorkerRequestFrame, { type: "initialize" }>): void {
	const readyFrame: OperationWorkerEventFrame = {
		type: "ready",
		requestId: frame.requestId,
		workerId: frame.binding.workerId,
		providerId: frame.binding.providerId,
		requestFingerprint: frame.binding.requestFingerprint,
		capabilities: [...frame.binding.capabilitySummary],
	};
	const profile = frame.binding.profileId;
	if (profile === "sequence_drift") {
		emitBatch([
			readyFrame,
			{ type: "heartbeat", workerId: frame.binding.workerId, sequence: 2, at: now() },
			{ type: "heartbeat", workerId: frame.binding.workerId, sequence: 1, at: now() },
		]);
		return;
	}
	if (profile === "heartbeat_stall") {
		heartbeatSequence += 1;
		emitBatch([
			readyFrame,
			{ type: "heartbeat", workerId: frame.binding.workerId, sequence: heartbeatSequence, at: now() },
		]);
		return;
	}
	emit(readyFrame);
	startHeartbeat();
}

function handleInitialize(frame: Extract<OperationWorkerRequestFrame, { type: "initialize" }>): void {
	binding = frame.binding;
	const profile = frame.binding.profileId;
	if (profile === "environment_probe" && process.env.AOS_WORKER_SECRET_SENTINEL !== undefined) {
		process.stdout.write("{invalid inherited environment\n");
		return;
	}
	if (profile === "malformed") {
		process.stdout.write("{malformed worker frame\n");
		return;
	}
	if (profile === "oversize") {
		process.stdout.write(`${"x".repeat(MAX_FRAME_BYTES + 1)}\n`);
		return;
	}
	if (profile === "ready_timeout") return;
	if (profile === "ready_slow") {
		setTimeout(() => ready(frame), 40);
		return;
	}
	ready(frame);
}

function handleExecute(frame: Extract<OperationWorkerRequestFrame, { type: "execute" }>): void {
	activeExecute = frame;
	emit({
		type: "operation.started",
		requestId: frame.requestId,
		workerId: frame.workerId,
		operationId: frame.operationId,
		at: now(),
	});
	const profile = binding!.profileId;
	if (profile === "disconnect") {
		stopHeartbeat();
		process.exitCode = 17;
		process.stdin.destroy();
		return;
	}
	if (profile === "cancel_success" || profile === "cancel_timeout") return;
	if (profile === "deadline_late") {
		setTimeout(() => complete(frame, "succeeded"), 2_000);
		return;
	}
	if (profile === "receipt_invalid") {
		complete(frame, "succeeded", { taskId: "drift-task" });
		return;
	}
	complete(frame, profile === "failure" ? "failed" : "succeeded");
}

function handleCancel(): void {
	if (binding?.profileId !== "cancel_success" || activeExecute === undefined) return;
	complete(activeExecute, "cancelled");
}

function exitCleanly(): void {
	stopHeartbeat();
	if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
	process.stdout.write("", () => process.exit(0));
}

function handleReclaim(frame: Extract<OperationWorkerRequestFrame, { type: "reclaim" }>): void {
	if (binding?.profileId === "reclaim_unknown") {
		emit({
			type: "error",
			requestId: frame.requestId,
			workerId: frame.workerId,
			code: "worker_reclaim_failed",
		});
		return;
	}
	exitCleanly();
}

function handleFrame(frame: OperationWorkerRequestFrame): void {
	switch (frame.type) {
		case "initialize":
			handleInitialize(frame);
			return;
		case "execute":
			handleExecute(frame);
			return;
		case "cancel":
			handleCancel();
			return;
		case "reclaim":
			handleReclaim(frame);
			return;
		case "ping":
			emit({ type: "pong", requestId: frame.requestId, workerId: frame.workerId, at: now() });
			return;
		case "credential.project":
		case "credential.renew":
		case "credential.revoke":
			return;
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	inputBuffer += chunk;
	for (;;) {
		const newline = inputBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = inputBuffer.slice(0, newline + 1);
		inputBuffer = inputBuffer.slice(newline + 1);
		let frame: OperationWorkerRequestFrame;
		try {
			frame = JSON.parse(line) as OperationWorkerRequestFrame;
		} catch {
			process.exit(2);
			return;
		}
		handleFrame(frame);
	}
});
process.stdin.on("end", () => {
	if (binding?.profileId !== "reclaim_unknown") exitCleanly();
});

keepAliveTimer = setInterval(() => {}, 1_000);
