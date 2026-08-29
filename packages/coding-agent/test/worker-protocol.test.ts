import { describe, expect, it } from "vitest";
import type { WorkerReceipt } from "@aos-agent/agent-core";
import {
	WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES,
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES,
	WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS,
	applyOperationWorkerEventFrame,
	applyOperationWorkerRequestFrame,
	createOperationWorkerProtocolState,
	parseOperationWorkerFrame,
	parseWorkerJsonl,
	protocolStateValid,
	redactOperationWorkerDiagnostic,
	serializeWorkerFrameLine,
	serializeOperationWorkerFrame,
	validateOperationWorkerResult,
	validateOperationWorkerEventFrame,
	validateOperationWorkerRequestFrame,
	type SafeOperationResult,
	type OperationWorkerEventFrame,
	type OperationWorkerProtocolState,
	type OperationWorkerRequestFrame,
} from "../src/core/worker-protocol.ts";
import { FakeWorkerProtocolTransportV1 } from "./fixtures/worker-protocol-fake-transport.ts";
import type { WorkerBinding } from "../src/core/worker.ts";

const binding: WorkerBinding = {
	schemaVersion: 1,
	workerId: "worker-1",
	providerId: "sandbox-worker",
	sessionId: "session-1",
	laneId: "main",
	runId: "run-1",
	bindingId: "binding-1",
	bindingEpochId: "epoch-1",
	attemptId: "attempt-1",
	profileId: "local-worker",
	profileRevision: 1,
	capabilitySummary: ["filesystem.read", "process.spawn"],
	deadlineAt: Date.parse("2026-08-21T00:01:00.000Z"),
	credentialTargetRefs: ["target-1"],
	requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const request = {
	schemaVersion: 1 as const,
	operationId: "operation-1",
	providerId: binding.providerId,
	bindingId: binding.bindingId,
	bindingEpochId: binding.bindingEpochId,
	attemptId: binding.attemptId,
	taskId: "task-1",
	dispatchId: "dispatch-1",
	payload: { result: "ok" },
};

function applyRequest(state: OperationWorkerProtocolState, frame: OperationWorkerRequestFrame): OperationWorkerProtocolState {
	const result = applyOperationWorkerRequestFrame(state, frame);
	if (!result.ok) throw result.error;
	if (!protocolStateValid(result.value.state)) throw new Error("accepted Host transition produced invalid protocol state");
	return result.value.state;
}

function applyEvent(state: OperationWorkerProtocolState, frame: OperationWorkerEventFrame): OperationWorkerProtocolState {
	const result = applyOperationWorkerEventFrame(state, frame);
	if (!result.ok) throw result.error;
	if (!protocolStateValid(result.value.state)) throw new Error("accepted Worker transition produced invalid protocol state");
	return result.value.state;
}

function readyState(): OperationWorkerProtocolState {
	let state = createOperationWorkerProtocolState();
	state = applyRequest(state, { type: "initialize", requestId: "initialize-1", binding });
	state = applyEvent(state, {
		type: "ready",
		requestId: "initialize-1",
		workerId: binding.workerId,
		providerId: binding.providerId,
		requestFingerprint: binding.requestFingerprint,
		capabilities: [...binding.capabilitySummary],
	});
	return state;
}

function runningState(): OperationWorkerProtocolState {
	let state = readyState();
	state = applyRequest(state, { type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
	state = applyEvent(state, { type: "operation.started", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, at: "2026-08-21T00:00:01.000Z" });
	return state;
}

const completedResult: SafeOperationResult = {
	schemaVersion: 1,
	operationId: request.operationId,
	ok: true,
	sideEffectState: "none",
};

const receipt = {
	schemaVersion: 1 as const,
	workerReceiptId: "receipt-1",
	sandboxProviderId: binding.providerId,
	operationId: request.operationId,
	taskId: request.taskId,
	dispatchId: request.dispatchId,
	attemptId: request.attemptId,
	status: "succeeded" as const,
	sideEffectState: "none" as const,
	provenance: {
		producerKind: "operation_worker" as const,
		providerId: binding.providerId,
		producedAt: "2026-08-21T00:00:02.000Z",
		correlation: { sessionId: binding.sessionId, laneId: binding.laneId, operationId: request.operationId, taskId: request.taskId, dispatchId: request.dispatchId, attemptId: request.attemptId, revision: 0 },
	},
	startedAt: "2026-08-21T00:00:01.000Z",
	completedAt: "2026-08-21T00:00:02.000Z",
};

describe("private Operation Worker protocol", () => {
	it("enforces exact frame keys and rejects malformed nested safe values", () => {
		const initialize = { type: "initialize" as const, requestId: "initialize-1", binding };
		expect(validateOperationWorkerRequestFrame(initialize)).toBe(true);
		expect(validateOperationWorkerRequestFrame({ ...initialize, unexpected: true })).toBe(false);
		expect(applyOperationWorkerRequestFrame(createOperationWorkerProtocolState(), { ...initialize, unexpected: true })).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(validateOperationWorkerRequestFrame({ type: "unknown", requestId: "request-1" })).toBe(false);
		expect(parseOperationWorkerFrame('{"type":"unknown"}')).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(validateOperationWorkerResult({ ...completedResult, data: { path: "/tmp/private" } })).toBe(false);
		expect(validateOperationWorkerResult({ ...completedResult, extra: "field" })).toBe(false);
	});

	it("fails closed on cross-Worker frames and identity drift", () => {
		const state = readyState();
		expect(applyOperationWorkerEventFrame(state, { type: "heartbeat", workerId: "worker-2", sequence: 1, at: "2026-08-21T00:00:01.000Z" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(createOperationWorkerProtocolState(), { type: "heartbeat", workerId: binding.workerId, sequence: 1, at: "2026-08-21T00:00:01.000Z" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerRequestFrame(state, { type: "ping", requestId: "ping-1", workerId: "worker-2" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(
			applyRequest(state, { type: "ping", requestId: "ping-1", workerId: binding.workerId }),
			{ type: "pong", requestId: "ping-1", workerId: binding.workerId, at: "2026-08-21T00:00:01.000Z" },
		)).toMatchObject({ ok: true });
		expect(applyOperationWorkerEventFrame(state, { type: "ready", requestId: "initialize-1", workerId: binding.workerId, providerId: "other-provider", requestFingerprint: binding.requestFingerprint, capabilities: [] })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("requires ready capabilities to exactly echo the binding", () => {
		let state = createOperationWorkerProtocolState();
		state = applyRequest(state, { type: "initialize", requestId: "initialize-1", binding });
		expect(applyOperationWorkerEventFrame(state, {
			type: "ready",
			requestId: "initialize-1",
			workerId: binding.workerId,
			providerId: binding.providerId,
			requestFingerprint: binding.requestFingerprint,
			capabilities: [binding.capabilitySummary[0]!, "different-capability"],
		})).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("accepts only finite protocol error codes", () => {
		expect(validateOperationWorkerEventFrame({ type: "error", workerId: binding.workerId, code: "worker_not_a_real_code" })).toBe(false);
		expect(validateOperationWorkerResult({ ...completedResult, error: { code: "worker_not_a_real_code", message: "safe", retryable: false } })).toBe(false);
		expect(validateOperationWorkerEventFrame({ type: "error", workerId: binding.workerId, code: "worker_cancel_failed" })).toBe(true);
		for (const message of [
			"PID=1234",
			"executable=/usr/bin/worker",
			"argv=--secret",
			"cwd=/tmp/work",
			"path=/tmp/work",
			"env=TOKEN",
			"stdout=private output",
			"stderr=private error",
			"prompt=private prompt",
			"secret=private",
			"token=private",
			"header=Authorization",
			"provider stack trace",
			"VM/QEMU detail",
			"raw frame payload",
		]) {
			expect(validateOperationWorkerResult({ ...completedResult, error: { code: "worker_cancel_failed", message, retryable: false } })).toBe(false);
		}
	});

	it("enforces started and terminal once, including duplicate responses and receipts", () => {
		let state = runningState();
		const started = { type: "operation.started" as const, requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, at: "2026-08-21T00:00:01.000Z" };
		expect(applyOperationWorkerEventFrame(state, started)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		expect(applyOperationWorkerEventFrame(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "receipt", requestId: "execute-1", receipt });
		expect(applyOperationWorkerEventFrame(state, { type: "receipt", requestId: "execute-1", receipt })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyOperationWorkerEventFrame(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "late" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("blocks a completed operation until receipt, then unblocks execute", () => {
		const secondRequest = { ...request, operationId: "operation-2" };
		let state = runningState();
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		expect(protocolStateValid(state)).toBe(true);
		const secondFrame: OperationWorkerRequestFrame = { type: "execute", requestId: "execute-2", workerId: binding.workerId, operationId: secondRequest.operationId, request: secondRequest };
		expect(applyOperationWorkerRequestFrame(state, secondFrame)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "receipt", requestId: "execute-1", receipt });
		expect(protocolStateValid(state)).toBe(true);
		expect(applyOperationWorkerRequestFrame(state, secondFrame)).toMatchObject({ ok: true });

		let errorResolved = runningState();
		errorResolved = applyEvent(errorResolved, { type: "error", requestId: "execute-1", workerId: binding.workerId, code: "worker_operation_invalid" });
		expect(protocolStateValid(errorResolved)).toBe(true);
		expect(applyOperationWorkerRequestFrame(errorResolved, secondFrame)).toMatchObject({ ok: true });
	});

	it("checks direct apply frame bounds before mutation and round-trips bounded results", () => {
		const ready = readyState();
		const oversizedRequest = { ...request, operationId: "operation-oversized", payload: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_BYTES) };
		const oversizedExecute: OperationWorkerRequestFrame = {
			type: "execute",
			requestId: "execute-oversized",
			workerId: binding.workerId,
			operationId: oversizedRequest.operationId,
			request: oversizedRequest,
		};
		expect(validateOperationWorkerRequestFrame(oversizedExecute)).toBe(true);
		const readyBefore = JSON.stringify(ready);
		expect(applyOperationWorkerRequestFrame(ready, oversizedExecute)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(JSON.stringify(ready)).toBe(readyBefore);
		expect(protocolStateValid(ready)).toBe(true);

		const running = runningState();
		const oversizedCompleted: OperationWorkerEventFrame = {
			type: "operation.completed",
			requestId: "execute-1",
			workerId: binding.workerId,
			operationId: request.operationId,
			result: { ...completedResult, data: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_BYTES) },
		};
		expect(validateOperationWorkerEventFrame(oversizedCompleted)).toBe(true);
		const runningBefore = JSON.stringify(running);
		expect(applyOperationWorkerEventFrame(running, oversizedCompleted)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(JSON.stringify(running)).toBe(runningBefore);
		expect(protocolStateValid(running)).toBe(true);

		const boundedCompleted: OperationWorkerEventFrame = {
			type: "operation.completed",
			requestId: "execute-1",
			workerId: binding.workerId,
			operationId: request.operationId,
			result: { ...completedResult, data: { result: "ok" } },
		};
		const parsed = parseOperationWorkerFrame(serializeWorkerFrameLine(boundedCompleted));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const accepted = applyOperationWorkerEventFrame(running, parsed.value);
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(protocolStateValid(accepted.value.state)).toBe(true);
	});

	it("rejects receipt correlation drift against the execute request and binding", () => {
		let state = runningState();
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		const correlation = receipt.provenance.correlation!;
		const receiptFrame = (value: WorkerReceipt): OperationWorkerEventFrame => ({ type: "receipt", requestId: "execute-1", receipt: value });
		const receiptWithoutField = (field: "taskId" | "dispatchId" | "attemptId"): OperationWorkerEventFrame => {
			const value: Record<string, unknown> = { ...receipt };
			Reflect.deleteProperty(value, field);
			return receiptFrame(value as unknown as WorkerReceipt);
		};
		const receiptWithoutCorrelationField = (field: "taskId" | "dispatchId" | "attemptId"): OperationWorkerEventFrame => {
			const nextCorrelation: Record<string, unknown> = { ...correlation };
			Reflect.deleteProperty(nextCorrelation, field);
			return receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: nextCorrelation } } as unknown as WorkerReceipt);
		};
		for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
			expect(applyOperationWorkerEventFrame(state, receiptWithoutField(field))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
			expect(applyOperationWorkerEventFrame(state, receiptWithoutCorrelationField(field))).toMatchObject({ ok: false, error: { code: "worker_receipt_invalid" } });
		}
		expect(applyOperationWorkerEventFrame(state, receiptFrame({ ...receipt, taskId: "task-2", provenance: { ...receipt.provenance, correlation: { ...correlation, taskId: "task-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, receiptFrame({ ...receipt, dispatchId: "dispatch-2", provenance: { ...receipt.provenance, correlation: { ...correlation, dispatchId: "dispatch-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, receiptFrame({ ...receipt, attemptId: "attempt-2", provenance: { ...receipt.provenance, correlation: { ...correlation, attemptId: "attempt-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: { ...correlation, sessionId: "session-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: { ...correlation, laneId: "lane-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, { type: "receipt", requestId: "execute-1", receipt: { ...receipt, operationId: "operation-2", provenance: { ...receipt.provenance, correlation: { ...receipt.provenance.correlation!, operationId: "operation-2" } } } })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyOperationWorkerEventFrame(state, { type: "receipt", requestId: "execute-1", receipt: { ...receipt, sandboxProviderId: "provider-2", provenance: { ...receipt.provenance, providerId: "provider-2", correlation: { ...receipt.provenance.correlation! } } } })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("validates protocol state phase, response cardinality, and operation invariants", () => {
		const ready = readyState();
		expect(protocolStateValid({ ...ready, extra: true })).toBe(false);
		expect(protocolStateValid({ ...ready, phase: "invalid" as OperationWorkerProtocolState["phase"] })).toBe(false);
		expect(protocolStateValid({ ...ready, requests: ready.requests.map((item) => ({ ...item, responseCount: 2 })) })).toBe(false);
		expect(protocolStateValid({ ...ready, requests: ready.requests.map((item) => ({ ...item, responseType: "pong" as const })) })).toBe(false);
		expect(protocolStateValid({ ...ready, requests: ready.requests.map((item) => ({ ...item, responseCount: 1, responseType: "pong" as const })) })).toBe(false);
		expect(protocolStateValid({ ...ready, readyRequestId: "other-request" })).toBe(false);
		expect(protocolStateValid({ ...ready, requests: ready.requests.map((item) => item.type === "initialize" ? { ...item, providerId: binding.providerId } : item) })).toBe(false);
		const running = runningState();
		expect(protocolStateValid({ ...running, requests: running.requests.map((item) => item.type === "execute" ? { ...item, responseCount: 1, responseType: "receipt" as const } : item) })).toBe(false);
		expect(protocolStateValid({ ...running, operations: running.operations.map((item) => ({ ...item, requestId: "other-request" })) })).toBe(false);
		expect(protocolStateValid({ ...running, operations: running.operations.map((item) => ({ ...item, extra: true })) })).toBe(false);
		expect(protocolStateValid({ ...running, requests: running.requests.map((item) => ({ ...item, extra: true })) })).toBe(false);
		expect(applyOperationWorkerRequestFrame({ ...ready, phase: "invalid" as OperationWorkerProtocolState["phase"] }, { type: "ping", requestId: "ping-1", workerId: binding.workerId })).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("keeps a reclaimed terminal closed against late worker frames", () => {
		let state = runningState();
		state = applyRequest(state, { type: "reclaim", requestId: "reclaim-1", workerId: binding.workerId });
		expect(state.phase).toBe("terminal");
		expect(state.reclaimRequested).toBe(true);
		expect(protocolStateValid(state)).toBe(true);

		const lateFrames: readonly OperationWorkerEventFrame[] = [
			{ type: "operation.started", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, at: "2026-08-21T00:00:01.000Z" },
			{ type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "late" },
			{ type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult },
			{ type: "receipt", requestId: "execute-1", receipt },
			{ type: "pong", requestId: "ping-1", workerId: binding.workerId, at: "2026-08-21T00:00:03.000Z" },
			{ type: "heartbeat", workerId: binding.workerId, sequence: 1, at: "2026-08-21T00:00:03.000Z" },
			{ type: "error", requestId: "execute-1", workerId: binding.workerId, code: "worker_operation_invalid" },
			{ type: "error", workerId: binding.workerId, code: "worker_reclaim_failed" },
		];
		for (const frame of lateFrames) {
			expect(applyOperationWorkerEventFrame(state, frame)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
			expect(protocolStateValid(state)).toBe(true);
		}

		state = applyEvent(state, { type: "error", requestId: "reclaim-1", workerId: binding.workerId, code: "worker_reclaim_failed" });
		expect(state.phase).toBe("terminal");
		expect(state.reclaimRequested).toBe(true);
		expect(state.requests.find((item) => item.requestId === "reclaim-1")).toMatchObject({ responseCount: 1, responseType: "error" });
		expect(protocolStateValid(state)).toBe(true);
	});

	it("keeps heartbeat as monotonic liveness only", () => {
		const state = readyState();
		const first = applyOperationWorkerEventFrame(state, { type: "heartbeat", workerId: binding.workerId, sequence: 3, at: "2026-08-21T00:00:03.000Z" });
		expect(first).toMatchObject({ ok: true, value: { state: { heartbeatSequence: 3, lastHeartbeatAt: "2026-08-21T00:00:03.000Z" } } });
		if (!first.ok) return;
		expect(first.value.state.binding?.deadlineAt).toBe(binding.deadlineAt);
		expect(applyOperationWorkerEventFrame(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 2, at: "2026-08-21T00:00:04.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyOperationWorkerEventFrame(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 3, at: "2026-08-21T00:00:03.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyOperationWorkerEventFrame(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 4, at: "2026-08-21T00:00:02.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("deterministically truncates one chunk and rejects data after either aggregate cap", () => {
		let state = runningState();
		const hugeChunk = `${"界".repeat(Math.floor(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES / 3))}xx`;
		const first = applyOperationWorkerEventFrame(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: hugeChunk });
		expect(first).toMatchObject({ ok: true, value: { truncated: true, frame: { data: expect.any(String), truncated: true } } });
		if (!first.ok) return;
		state = first.value.state;
		for (let index = 1; index < WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES / WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES; index += 1) {
			const next = applyOperationWorkerEventFrame(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "x".repeat(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES) });
			if (!next.ok) throw next.error;
			state = next.value.state;
		}
		expect(state.operations[0]).toMatchObject({ dataEvents: 16, dataBytes: WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES, dataTruncated: true });
		expect(applyOperationWorkerEventFrame(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "overflow" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });

		let eventLimitedState = runningState();
		for (let index = 0; index < WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS; index += 1) {
			const next = applyOperationWorkerEventFrame(eventLimitedState, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "x" });
			if (!next.ok) throw next.error;
			eventLimitedState = next.value.state;
		}
		expect(applyOperationWorkerEventFrame(eventLimitedState, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		const serialized = JSON.parse(serializeOperationWorkerFrame({ type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "y".repeat(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES + 1) })) as { data: string; truncated?: boolean };
		expect(serialized.truncated).toBe(true);
		expect(new TextEncoder().encode(serialized.data).byteLength).toBe(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES);
	});

	it("parses exactly one JSONL frame and never exposes malformed input", () => {
		const frame: OperationWorkerRequestFrame = { type: "ping", requestId: "ping-1", workerId: binding.workerId };
		const line = serializeWorkerFrameLine(frame);
		expect(line.endsWith("\n")).toBe(true);
		expect(parseOperationWorkerFrame(line)).toMatchObject({ ok: true, value: frame });
		expect(parseWorkerJsonl(`${line}${line}`)).toMatchObject({ ok: true, value: [frame, frame] });
		expect(parseOperationWorkerFrame("not-json")).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(parseOperationWorkerFrame(`${line}${line}`)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("keeps stdout JSONL-only and redacts stderr diagnostics", () => {
		const transport = new FakeWorkerProtocolTransportV1(binding, "ready");
		const readyLines = transport.send({ type: "initialize", requestId: "initialize-1", binding });
		expect(readyLines.ok).toBe(true);
		if (!readyLines.ok) return;
		for (const line of readyLines.value) expect(parseOperationWorkerFrame(line).ok).toBe(true);
		expect(transport.state.phase).toBe("ready");
		const stderr = transport.stderr("childError=token=super-secret path=/tmp/private-work");
		expect(stderr).not.toContain("super-secret");
		expect(stderr).not.toContain("/tmp/private-work");
		expect(stderr.endsWith("\n")).toBe(true);
		for (const category of ["PID", "executable", "argv", "cwd", "path", "env", "stdout", "stderr", "prompt", "secret", "token", "header", "provider", "stack", "VM", "QEMU", "raw frame"]) {
			const diagnostic = `${category}=sensitive-${category.toLowerCase()}`;
			expect(redactOperationWorkerDiagnostic(diagnostic)).toBe("[redacted worker diagnostic]");
			expect(transport.stderr(diagnostic)).not.toContain(`sensitive-${category.toLowerCase()}`);
		}
	});

	it("covers fake ready, slow, cancel acknowledgement, receipt, disconnect, malformed, and oversized data", () => {
		const ready = new FakeWorkerProtocolTransportV1(binding, "ready");
		const readyResult = ready.send({ type: "initialize", requestId: "initialize-1", binding });
		expect(readyResult.ok).toBe(true);
		const heartbeat = new FakeWorkerProtocolTransportV1(binding, "ready");
		heartbeat.send({ type: "initialize", requestId: "initialize-1", binding });
		const heartbeatOutput = heartbeat.sendHeartbeat(1, "2026-08-21T00:00:03.000Z");
		expect(heartbeatOutput).toMatchObject({ ok: true, value: [expect.stringContaining('"type":"heartbeat"')] });
		if (heartbeatOutput.ok) expect(parseOperationWorkerFrame(heartbeatOutput.value[0]!).ok).toBe(true);
		expect(heartbeat.state).toMatchObject({ heartbeatSequence: 1, lastHeartbeatAt: "2026-08-21T00:00:03.000Z" });
		expect(heartbeat.state.binding?.deadlineAt).toBe(binding.deadlineAt);
		expect(heartbeat.sendHeartbeat(1, "2026-08-21T00:00:04.000Z")).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(heartbeat.sendHeartbeat(2, "2026-08-21T00:00:02.000Z")).toMatchObject({ ok: false, error: { code: "worker_conflict" } });

		const slow = new FakeWorkerProtocolTransportV1(binding, "slow");
		expect(slow.send({ type: "initialize", requestId: "initialize-1", binding }).ok).toBe(true);
		const slowOutput = slow.send({ type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
		expect(slowOutput).toMatchObject({ ok: true, value: [] });

		const cancel = new FakeWorkerProtocolTransportV1(binding, "cancel_ack");
		cancel.send({ type: "initialize", requestId: "initialize-1", binding });
		cancel.send({ type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
		const cancelOutput = cancel.send({ type: "cancel", requestId: "cancel-1", workerId: binding.workerId, operationId: request.operationId, reason: "cancel" });
		expect(cancelOutput).toMatchObject({ ok: true, value: [] });
		expect(cancel.state.phase).toBe("cancelling");
		expect(cancel.state.operations[0]).toMatchObject({ started: true, terminal: false, receiptReceived: false });

		const receiptTransport = new FakeWorkerProtocolTransportV1(binding, "receipt");
		receiptTransport.send({ type: "initialize", requestId: "initialize-1", binding });
		const receiptOutput = receiptTransport.send({ type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
		expect(receiptOutput).toMatchObject({ ok: true, value: expect.arrayContaining([expect.stringContaining("\"type\":\"receipt\"")]) });

		const disconnected = new FakeWorkerProtocolTransportV1(binding, "disconnect");
		expect(disconnected.send({ type: "initialize", requestId: "initialize-1", binding })).toMatchObject({ ok: false, error: { code: "worker_lost" } });

		const malformed = new FakeWorkerProtocolTransportV1(binding, "malformed");
		const malformedOutput = malformed.send({ type: "initialize", requestId: "initialize-1", binding });
		expect(malformedOutput).toMatchObject({ ok: true, value: ["{malformed worker frame"] });
		if (malformedOutput.ok) expect(parseOperationWorkerFrame(malformedOutput.value[0]!)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });

		const oversized = new FakeWorkerProtocolTransportV1(binding, "oversized_data");
		oversized.send({ type: "initialize", requestId: "initialize-1", binding });
		const oversizedOutput = oversized.send({ type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
		expect(oversizedOutput.ok).toBe(true);
		expect(oversized.state.operations[0]).toMatchObject({ dataTruncated: true, dataBytes: WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES });
	});
});
