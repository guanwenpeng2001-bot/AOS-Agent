import { describe, expect, it } from "vitest";
import type { WorkerReceiptV1 } from "@aos-agent/agent-core";
import {
	WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES,
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES,
	WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS,
	applyWorkerEventFrameV1,
	applyWorkerRequestFrameV1,
	createWorkerProtocolStateV1,
	parseWorkerFrameV1,
	parseWorkerJsonlV1,
	protocolStateValid,
	redactWorkerDiagnosticV1,
	serializeWorkerFrameLineV1,
	serializeWorkerFrameV1,
	validateSafeOperationResultV1,
	validateWorkerEventFrameV1,
	validateWorkerRequestFrameV1,
	type SafeOperationResultV1,
	type WorkerEventFrameV1,
	type WorkerProtocolStateV1,
	type WorkerRequestFrameV1,
} from "../src/core/worker-protocol.ts";
import { FakeWorkerProtocolTransportV1 } from "./fixtures/worker-protocol-fake-transport.ts";
import type { WorkerBindingV1 } from "../src/core/worker.ts";

const binding: WorkerBindingV1 = {
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

function applyRequest(state: WorkerProtocolStateV1, frame: WorkerRequestFrameV1): WorkerProtocolStateV1 {
	const result = applyWorkerRequestFrameV1(state, frame);
	if (!result.ok) throw result.error;
	if (!protocolStateValid(result.value.state)) throw new Error("accepted Host transition produced invalid protocol state");
	return result.value.state;
}

function applyEvent(state: WorkerProtocolStateV1, frame: WorkerEventFrameV1): WorkerProtocolStateV1 {
	const result = applyWorkerEventFrameV1(state, frame);
	if (!result.ok) throw result.error;
	if (!protocolStateValid(result.value.state)) throw new Error("accepted Worker transition produced invalid protocol state");
	return result.value.state;
}

function readyState(): WorkerProtocolStateV1 {
	let state = createWorkerProtocolStateV1();
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

function runningState(): WorkerProtocolStateV1 {
	let state = readyState();
	state = applyRequest(state, { type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
	state = applyEvent(state, { type: "operation.started", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, at: "2026-08-21T00:00:01.000Z" });
	return state;
}

const completedResult: SafeOperationResultV1 = {
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
		expect(validateWorkerRequestFrameV1(initialize)).toBe(true);
		expect(validateWorkerRequestFrameV1({ ...initialize, unexpected: true })).toBe(false);
		expect(applyWorkerRequestFrameV1(createWorkerProtocolStateV1(), { ...initialize, unexpected: true })).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(validateWorkerRequestFrameV1({ type: "unknown", requestId: "request-1" })).toBe(false);
		expect(parseWorkerFrameV1('{"type":"unknown"}')).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(validateSafeOperationResultV1({ ...completedResult, data: { path: "/tmp/private" } })).toBe(false);
		expect(validateSafeOperationResultV1({ ...completedResult, extra: "field" })).toBe(false);
	});

	it("fails closed on cross-Worker frames and identity drift", () => {
		const state = readyState();
		expect(applyWorkerEventFrameV1(state, { type: "heartbeat", workerId: "worker-2", sequence: 1, at: "2026-08-21T00:00:01.000Z" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(createWorkerProtocolStateV1(), { type: "heartbeat", workerId: binding.workerId, sequence: 1, at: "2026-08-21T00:00:01.000Z" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerRequestFrameV1(state, { type: "ping", requestId: "ping-1", workerId: "worker-2" })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(
			applyRequest(state, { type: "ping", requestId: "ping-1", workerId: binding.workerId }),
			{ type: "pong", requestId: "ping-1", workerId: binding.workerId, at: "2026-08-21T00:00:01.000Z" },
		)).toMatchObject({ ok: true });
		expect(applyWorkerEventFrameV1(state, { type: "ready", requestId: "initialize-1", workerId: binding.workerId, providerId: "other-provider", requestFingerprint: binding.requestFingerprint, capabilities: [] })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("requires ready capabilities to exactly echo the binding", () => {
		let state = createWorkerProtocolStateV1();
		state = applyRequest(state, { type: "initialize", requestId: "initialize-1", binding });
		expect(applyWorkerEventFrameV1(state, {
			type: "ready",
			requestId: "initialize-1",
			workerId: binding.workerId,
			providerId: binding.providerId,
			requestFingerprint: binding.requestFingerprint,
			capabilities: [binding.capabilitySummary[0]!, "different-capability"],
		})).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("accepts only finite protocol error codes", () => {
		expect(validateWorkerEventFrameV1({ type: "error", workerId: binding.workerId, code: "worker_not_a_real_code" })).toBe(false);
		expect(validateSafeOperationResultV1({ ...completedResult, error: { code: "worker_not_a_real_code", message: "safe", retryable: false } })).toBe(false);
		expect(validateWorkerEventFrameV1({ type: "error", workerId: binding.workerId, code: "worker_cancel_failed" })).toBe(true);
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
			expect(validateSafeOperationResultV1({ ...completedResult, error: { code: "worker_cancel_failed", message, retryable: false } })).toBe(false);
		}
	});

	it("enforces started and terminal once, including duplicate responses and receipts", () => {
		let state = runningState();
		const started = { type: "operation.started" as const, requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, at: "2026-08-21T00:00:01.000Z" };
		expect(applyWorkerEventFrameV1(state, started)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		expect(applyWorkerEventFrameV1(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "receipt", requestId: "execute-1", receipt });
		expect(applyWorkerEventFrameV1(state, { type: "receipt", requestId: "execute-1", receipt })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyWorkerEventFrameV1(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "late" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("blocks a completed operation until receipt, then unblocks execute", () => {
		const secondRequest = { ...request, operationId: "operation-2" };
		let state = runningState();
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		expect(protocolStateValid(state)).toBe(true);
		const secondFrame: WorkerRequestFrameV1 = { type: "execute", requestId: "execute-2", workerId: binding.workerId, operationId: secondRequest.operationId, request: secondRequest };
		expect(applyWorkerRequestFrameV1(state, secondFrame)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		state = applyEvent(state, { type: "receipt", requestId: "execute-1", receipt });
		expect(protocolStateValid(state)).toBe(true);
		expect(applyWorkerRequestFrameV1(state, secondFrame)).toMatchObject({ ok: true });

		let errorResolved = runningState();
		errorResolved = applyEvent(errorResolved, { type: "error", requestId: "execute-1", workerId: binding.workerId, code: "worker_operation_invalid" });
		expect(protocolStateValid(errorResolved)).toBe(true);
		expect(applyWorkerRequestFrameV1(errorResolved, secondFrame)).toMatchObject({ ok: true });
	});

	it("checks direct apply frame bounds before mutation and round-trips bounded results", () => {
		const ready = readyState();
		const oversizedRequest = { ...request, operationId: "operation-oversized", payload: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_BYTES) };
		const oversizedExecute: WorkerRequestFrameV1 = {
			type: "execute",
			requestId: "execute-oversized",
			workerId: binding.workerId,
			operationId: oversizedRequest.operationId,
			request: oversizedRequest,
		};
		expect(validateWorkerRequestFrameV1(oversizedExecute)).toBe(true);
		const readyBefore = JSON.stringify(ready);
		expect(applyWorkerRequestFrameV1(ready, oversizedExecute)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(JSON.stringify(ready)).toBe(readyBefore);
		expect(protocolStateValid(ready)).toBe(true);

		const running = runningState();
		const oversizedCompleted: WorkerEventFrameV1 = {
			type: "operation.completed",
			requestId: "execute-1",
			workerId: binding.workerId,
			operationId: request.operationId,
			result: { ...completedResult, data: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_BYTES) },
		};
		expect(validateWorkerEventFrameV1(oversizedCompleted)).toBe(true);
		const runningBefore = JSON.stringify(running);
		expect(applyWorkerEventFrameV1(running, oversizedCompleted)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(JSON.stringify(running)).toBe(runningBefore);
		expect(protocolStateValid(running)).toBe(true);

		const boundedCompleted: WorkerEventFrameV1 = {
			type: "operation.completed",
			requestId: "execute-1",
			workerId: binding.workerId,
			operationId: request.operationId,
			result: { ...completedResult, data: { result: "ok" } },
		};
		const parsed = parseWorkerFrameV1(serializeWorkerFrameLineV1(boundedCompleted));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const accepted = applyWorkerEventFrameV1(running, parsed.value);
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(protocolStateValid(accepted.value.state)).toBe(true);
	});

	it("rejects receipt correlation drift against the execute request and binding", () => {
		let state = runningState();
		state = applyEvent(state, { type: "operation.completed", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, result: completedResult });
		const correlation = receipt.provenance.correlation!;
		const receiptFrame = (value: WorkerReceiptV1): WorkerEventFrameV1 => ({ type: "receipt", requestId: "execute-1", receipt: value });
		const receiptWithoutField = (field: "taskId" | "dispatchId" | "attemptId"): WorkerEventFrameV1 => {
			const value: Record<string, unknown> = { ...receipt };
			Reflect.deleteProperty(value, field);
			return receiptFrame(value as unknown as WorkerReceiptV1);
		};
		const receiptWithoutCorrelationField = (field: "taskId" | "dispatchId" | "attemptId"): WorkerEventFrameV1 => {
			const nextCorrelation: Record<string, unknown> = { ...correlation };
			Reflect.deleteProperty(nextCorrelation, field);
			return receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: nextCorrelation } } as unknown as WorkerReceiptV1);
		};
		for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
			expect(applyWorkerEventFrameV1(state, receiptWithoutField(field))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
			expect(applyWorkerEventFrameV1(state, receiptWithoutCorrelationField(field))).toMatchObject({ ok: false, error: { code: "worker_receipt_invalid" } });
		}
		expect(applyWorkerEventFrameV1(state, receiptFrame({ ...receipt, taskId: "task-2", provenance: { ...receipt.provenance, correlation: { ...correlation, taskId: "task-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, receiptFrame({ ...receipt, dispatchId: "dispatch-2", provenance: { ...receipt.provenance, correlation: { ...correlation, dispatchId: "dispatch-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, receiptFrame({ ...receipt, attemptId: "attempt-2", provenance: { ...receipt.provenance, correlation: { ...correlation, attemptId: "attempt-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: { ...correlation, sessionId: "session-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, receiptFrame({ ...receipt, provenance: { ...receipt.provenance, correlation: { ...correlation, laneId: "lane-2" } } }))).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, { type: "receipt", requestId: "execute-1", receipt: { ...receipt, operationId: "operation-2", provenance: { ...receipt.provenance, correlation: { ...receipt.provenance.correlation!, operationId: "operation-2" } } } })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
		expect(applyWorkerEventFrameV1(state, { type: "receipt", requestId: "execute-1", receipt: { ...receipt, sandboxProviderId: "provider-2", provenance: { ...receipt.provenance, providerId: "provider-2", correlation: { ...receipt.provenance.correlation! } } } })).toMatchObject({ ok: false, error: { code: "worker_binding_invalid" } });
	});

	it("validates protocol state phase, response cardinality, and operation invariants", () => {
		const ready = readyState();
		expect(protocolStateValid({ ...ready, extra: true })).toBe(false);
		expect(protocolStateValid({ ...ready, phase: "invalid" as WorkerProtocolStateV1["phase"] })).toBe(false);
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
		expect(applyWorkerRequestFrameV1({ ...ready, phase: "invalid" as WorkerProtocolStateV1["phase"] }, { type: "ping", requestId: "ping-1", workerId: binding.workerId })).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("keeps a reclaimed terminal closed against late worker frames", () => {
		let state = runningState();
		state = applyRequest(state, { type: "reclaim", requestId: "reclaim-1", workerId: binding.workerId });
		expect(state.phase).toBe("terminal");
		expect(state.reclaimRequested).toBe(true);
		expect(protocolStateValid(state)).toBe(true);

		const lateFrames: readonly WorkerEventFrameV1[] = [
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
			expect(applyWorkerEventFrameV1(state, frame)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
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
		const first = applyWorkerEventFrameV1(state, { type: "heartbeat", workerId: binding.workerId, sequence: 3, at: "2026-08-21T00:00:03.000Z" });
		expect(first).toMatchObject({ ok: true, value: { state: { heartbeatSequence: 3, lastHeartbeatAt: "2026-08-21T00:00:03.000Z" } } });
		if (!first.ok) return;
		expect(first.value.state.binding?.deadlineAt).toBe(binding.deadlineAt);
		expect(applyWorkerEventFrameV1(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 2, at: "2026-08-21T00:00:04.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyWorkerEventFrameV1(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 3, at: "2026-08-21T00:00:03.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(applyWorkerEventFrameV1(first.value.state, { type: "heartbeat", workerId: binding.workerId, sequence: 4, at: "2026-08-21T00:00:02.000Z" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("deterministically truncates one chunk and rejects data after either aggregate cap", () => {
		let state = runningState();
		const hugeChunk = `${"界".repeat(Math.floor(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES / 3))}xx`;
		const first = applyWorkerEventFrameV1(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: hugeChunk });
		expect(first).toMatchObject({ ok: true, value: { truncated: true, frame: { data: expect.any(String), truncated: true } } });
		if (!first.ok) return;
		state = first.value.state;
		for (let index = 1; index < WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES / WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES; index += 1) {
			const next = applyWorkerEventFrameV1(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "x".repeat(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES) });
			if (!next.ok) throw next.error;
			state = next.value.state;
		}
		expect(state.operations[0]).toMatchObject({ dataEvents: 16, dataBytes: WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES, dataTruncated: true });
		expect(applyWorkerEventFrameV1(state, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "overflow" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });

		let eventLimitedState = runningState();
		for (let index = 0; index < WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS; index += 1) {
			const next = applyWorkerEventFrameV1(eventLimitedState, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "x" });
			if (!next.ok) throw next.error;
			eventLimitedState = next.value.state;
		}
		expect(applyWorkerEventFrameV1(eventLimitedState, { type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "" })).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		const serialized = JSON.parse(serializeWorkerFrameV1({ type: "operation.data", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, stream: "content", data: "y".repeat(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES + 1) })) as { data: string; truncated?: boolean };
		expect(serialized.truncated).toBe(true);
		expect(new TextEncoder().encode(serialized.data).byteLength).toBe(WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES);
	});

	it("parses exactly one JSONL frame and never exposes malformed input", () => {
		const frame: WorkerRequestFrameV1 = { type: "ping", requestId: "ping-1", workerId: binding.workerId };
		const line = serializeWorkerFrameLineV1(frame);
		expect(line.endsWith("\n")).toBe(true);
		expect(parseWorkerFrameV1(line)).toMatchObject({ ok: true, value: frame });
		expect(parseWorkerJsonlV1(`${line}${line}`)).toMatchObject({ ok: true, value: [frame, frame] });
		expect(parseWorkerFrameV1("not-json")).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(parseWorkerFrameV1(`${line}${line}`)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("keeps stdout JSONL-only and redacts stderr diagnostics", () => {
		const transport = new FakeWorkerProtocolTransportV1(binding, "ready");
		const readyLines = transport.send({ type: "initialize", requestId: "initialize-1", binding });
		expect(readyLines.ok).toBe(true);
		if (!readyLines.ok) return;
		for (const line of readyLines.value) expect(parseWorkerFrameV1(line).ok).toBe(true);
		expect(transport.state.phase).toBe("ready");
		const stderr = transport.stderr("childError=token=super-secret path=/tmp/private-work");
		expect(stderr).not.toContain("super-secret");
		expect(stderr).not.toContain("/tmp/private-work");
		expect(stderr.endsWith("\n")).toBe(true);
		for (const category of ["PID", "executable", "argv", "cwd", "path", "env", "stdout", "stderr", "prompt", "secret", "token", "header", "provider", "stack", "VM", "QEMU", "raw frame"]) {
			const diagnostic = `${category}=sensitive-${category.toLowerCase()}`;
			expect(redactWorkerDiagnosticV1(diagnostic)).toBe("[redacted worker diagnostic]");
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
		if (heartbeatOutput.ok) expect(parseWorkerFrameV1(heartbeatOutput.value[0]!).ok).toBe(true);
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
		if (malformedOutput.ok) expect(parseWorkerFrameV1(malformedOutput.value[0]!)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });

		const oversized = new FakeWorkerProtocolTransportV1(binding, "oversized_data");
		oversized.send({ type: "initialize", requestId: "initialize-1", binding });
		const oversizedOutput = oversized.send({ type: "execute", requestId: "execute-1", workerId: binding.workerId, operationId: request.operationId, request });
		expect(oversizedOutput.ok).toBe(true);
		expect(oversized.state.operations[0]).toMatchObject({ dataTruncated: true, dataBytes: WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES });
	});
});
