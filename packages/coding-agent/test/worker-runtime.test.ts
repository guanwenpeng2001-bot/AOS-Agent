import { PassThrough } from "node:stream";
import { validateWorkerReceiptForProvider } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	serializeWorkerFrameLine,
	validateOperationWorkerEventFrame,
	type SafeLeaseProjection,
	type SafeLeaseReference,
	type OperationWorkerEventFrame,
	type OperationWorkerRequestFrame,
} from "../src/core/worker/protocol.ts";
import { OperationWorkerRuntime } from "../src/core/worker/runtime.ts";
import type { WorkerBinding } from "../src/core/worker/lifecycle.ts";
import { runOperationWorkerProcess } from "../src/worker-entry.ts";
import { FakeWorkerProviderV1 } from "./fixtures/fake-worker-provider.ts";

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
	toolCallId: "tool-call-1",
	agentInstanceId: "upstream-agent-only",
	payload: { result: "ok" },
};

const initialize: OperationWorkerRequestFrame = { type: "initialize", requestId: "initialize-1", binding };
const execute: OperationWorkerRequestFrame = {
	type: "execute",
	requestId: "execute-1",
	workerId: binding.workerId,
	operationId: request.operationId,
	request,
};
const lease: SafeLeaseProjection = {
	schemaVersion: 1,
	leaseId: "lease-1",
	grantId: "grant-1",
	bindingId: binding.bindingId!,
	scopeDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	expiresAt: "2026-08-21T00:01:00.000Z",
	clientRequestId: "credential-1",
};
const leaseRef: SafeLeaseReference = {
	schemaVersion: 1,
	leaseId: lease.leaseId,
	grantId: lease.grantId,
	bindingId: lease.bindingId,
	clientRequestId: lease.clientRequestId,
};

function harness(provider = new FakeWorkerProviderV1()): {
	readonly provider: FakeWorkerProviderV1;
	readonly runtime: OperationWorkerRuntime;
	readonly frames: OperationWorkerEventFrame[];
	readonly diagnostics: string[];
} {
	const frames: OperationWorkerEventFrame[] = [];
	const diagnostics: string[] = [];
	const runtime = new OperationWorkerRuntime({
		provider,
		emit: (frame) => {
			frames.push(frame);
		},
		diagnostic: (line) => diagnostics.push(line),
		now: () => "2026-08-21T00:00:01.000Z",
		heartbeatIntervalMs: 0,
	});
	return { provider, runtime, frames, diagnostics };
}

describe("trusted Operation Worker runtime", () => {
	it("fails initialize closed on provider identity mismatch without ready or provider effects", async () => {
		const provider = new FakeWorkerProviderV1({ providerId: "mismatched-provider" });
		const state = harness(provider);
		await state.runtime.receiveFrame(initialize);

		expect(state.frames).toEqual([
			expect.objectContaining({ type: "error", requestId: initialize.requestId, workerId: binding.workerId, code: "worker_binding_invalid" }),
		]);
		expect(state.runtime.closed).toBe(true);
		expect(provider.capabilityCalls).toBe(0);
		expect(provider.starts).toEqual([]);
		expect(provider.cancellations).toEqual([]);
		expect(provider.projectedLeases).toEqual([]);
		expect(provider.renewedLeases).toEqual([]);
		expect(provider.revokedLeases).toEqual([]);
		expect(provider.disposeCalls).toBe(0);
		expect(state.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
		expect(JSON.stringify(state.frames)).not.toContain(provider.providerId);
		await state.runtime.receiveFrame(execute);
		expect(provider.starts).toEqual([]);
	});

	it("fails execute before initialize closed without provider calls, output, or raw-frame leakage", async () => {
		const provider = new FakeWorkerProviderV1();
		const state = harness(provider);
		const rawMarker = "raw-execute-before-initialize";
		const earlyExecute: OperationWorkerRequestFrame = {
			...execute,
			request: { ...request, payload: { detail: rawMarker } },
		};
		await state.runtime.receiveLine(serializeWorkerFrameLine(earlyExecute));

		expect(state.runtime.closed).toBe(true);
		expect(state.frames).toEqual([]);
		expect(provider.capabilityCalls).toBe(0);
		expect(provider.starts).toEqual([]);
		expect(provider.cancellations).toEqual([]);
		expect(provider.projectedLeases).toEqual([]);
		expect(provider.renewedLeases).toEqual([]);
		expect(provider.revokedLeases).toEqual([]);
		expect(provider.disposeCalls).toBe(0);
		expect(state.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
		expect(state.diagnostics.join("")).not.toContain(rawMarker);
		expect(JSON.stringify(state.frames)).not.toContain(rawMarker);
	});

	it("emits ready only after initialize and requires exact provider capabilities", async () => {
		const accepted = harness();
		expect(accepted.frames).toEqual([]);
		await accepted.runtime.receiveFrame(initialize);
		expect(accepted.frames).toEqual([
			{
				type: "ready",
				requestId: initialize.requestId,
				workerId: binding.workerId,
				providerId: binding.providerId,
				requestFingerprint: binding.requestFingerprint,
				capabilities: binding.capabilitySummary,
			},
		]);

		const mismatch = harness(new FakeWorkerProviderV1({ capabilities: ["filesystem.read"] }));
		await mismatch.runtime.receiveFrame(initialize);
		expect(mismatch.frames).toEqual([
			expect.objectContaining({ type: "error", requestId: initialize.requestId, code: "sandbox_capability_insufficient" }),
		]);
		expect(mismatch.runtime.closed).toBe(true);
	});

	it("executes only through the injected provider and emits one correlated WorkerReceiptV1", async () => {
		const state = harness();
		await state.runtime.receiveFrame(initialize);
		await state.runtime.receiveFrame(execute);
		await state.runtime.waitForIdle();

		expect(state.provider.starts).toHaveLength(1);
		expect(state.provider.starts[0]).toMatchObject({
			request,
			correlation: {
				sessionId: binding.sessionId,
				laneId: binding.laneId,
				providerId: binding.providerId,
				operationId: request.operationId,
				taskId: request.taskId,
				dispatchId: request.dispatchId,
				attemptId: request.attemptId,
			},
		});
		expect(state.provider.starts[0]?.correlation).not.toHaveProperty("agentInstanceId");
		expect(state.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started", "operation.completed", "receipt"]);
		const receipts = state.frames.filter((frame) => frame.type === "receipt");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			receipt: {
				schemaVersion: 1,
				sandboxProviderId: binding.providerId,
				operationId: request.operationId,
				status: "succeeded",
				sideEffectState: "none",
			},
		});
		if (receipts[0]?.type !== "receipt") throw new Error("Expected Worker receipt");
		expect(receipts[0].receipt.provenance.correlation).not.toHaveProperty("agentInstanceId");
		await state.runtime.receiveFrame(execute);
		expect(state.runtime.closed).toBe(true);
		expect(state.frames.filter((frame) => frame.type === "receipt")).toHaveLength(1);
	});

	it("fails closed on invalid input and receipt correlation drift", async () => {
		const invalid = harness();
		await invalid.runtime.receiveLine('{"type":"unknown","secret":"must-not-leak"}');
		expect(invalid.runtime.closed).toBe(true);
		expect(invalid.frames).toEqual([]);
		expect(invalid.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");

		const drift = harness(new FakeWorkerProviderV1({ startBehavior: "correlation-drift" }));
		await drift.runtime.receiveFrame(initialize);
		await drift.runtime.receiveFrame(execute);
		await drift.runtime.waitForIdle();
		expect(drift.runtime.closed).toBe(true);
		expect(drift.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started", "error"]);
		expect(drift.frames.at(-1)).toMatchObject({ code: "worker_receipt_invalid" });
	});

	it("fails closed before transport output when a valid provider result exceeds the complete-frame bound", async () => {
		const state = harness(new FakeWorkerProviderV1({ startBehavior: "oversized-frame" }));
		await state.runtime.receiveFrame(initialize);
		await state.runtime.receiveFrame(execute);
		await state.runtime.waitForIdle();

		const receipt = state.provider.receipts[0]!;
		expect(validateWorkerReceiptForProvider(receipt, { providerId: binding.providerId, providerClass: "operation_worker" }).ok).toBe(true);
		const completed: OperationWorkerEventFrame = {
			type: "operation.completed",
			requestId: execute.requestId,
			workerId: binding.workerId,
			operationId: request.operationId,
			result: {
				schemaVersion: 1,
				operationId: request.operationId,
				ok: true,
				sideEffectState: "none",
				artifacts: receipt.artifacts,
			},
		};
		expect(validateOperationWorkerEventFrame(completed)).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(completed), "utf8") + 1).toBeGreaterThan(WORKER_PROTOCOL_MAX_FRAME_BYTES);
		expect(() => serializeWorkerFrameLine(completed)).toThrow();
		const receiptFrame: OperationWorkerEventFrame = { type: "receipt", requestId: execute.requestId, receipt };
		expect(validateOperationWorkerEventFrame(receiptFrame)).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(receiptFrame), "utf8") + 1).toBeGreaterThan(WORKER_PROTOCOL_MAX_FRAME_BYTES);
		expect(() => serializeWorkerFrameLine(receiptFrame)).toThrow();
		expect(state.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started"]);
		expect(state.runtime.closed).toBe(true);
		expect(state.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
		expect(JSON.stringify(execute)).not.toContain("oversized-provider-result");
		expect(JSON.stringify(state.runtime.binding)).not.toContain("oversized-provider-result");
		expect(JSON.stringify(state.frames)).not.toContain("oversized-provider-result");
		expect(state.diagnostics.join("")).not.toContain("oversized-provider-result");
	});

	it("projects, renews, and revokes safe credential references and reports target failures", async () => {
		const state = harness(new FakeWorkerProviderV1({ failedCredentialActions: ["renew"] }));
		await state.runtime.receiveFrame(initialize);
		await state.runtime.receiveFrame({ type: "credential.project", requestId: "project-1", workerId: binding.workerId, lease });
		await state.runtime.receiveFrame({ type: "credential.renew", requestId: "renew-1", workerId: binding.workerId, lease });
		await state.runtime.receiveFrame({ type: "credential.revoke", requestId: "revoke-1", workerId: binding.workerId, leaseRef });

		expect(state.provider.projectedLeases).toEqual([lease]);
		expect(state.provider.renewedLeases).toEqual([lease]);
		expect(state.provider.revokedLeases).toEqual([leaseRef]);
		expect(state.frames.filter((frame) => frame.type === "error")).toEqual([
			expect.objectContaining({ requestId: "renew-1", code: "task_credential_target_unavailable" }),
		]);
	});

	it("forwards cancel without treating its acknowledgement as side-effect closure", async () => {
		const state = harness(new FakeWorkerProviderV1({ startBehavior: "pending" }));
		await state.runtime.receiveFrame(initialize);
		await state.runtime.receiveFrame(execute);
		await state.runtime.receiveFrame({ type: "cancel", requestId: "cancel-1", workerId: binding.workerId, operationId: request.operationId, reason: "cancel" });

		expect(state.provider.cancellations).toEqual([request.operationId]);
		expect(state.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started"]);
		state.provider.completePending();
		await state.runtime.waitForIdle();
		expect(state.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started", "operation.completed", "receipt"]);
	});

	it("maps provider Result.err and cancel failure without leaking provider detail", async () => {
		const rejected = harness(new FakeWorkerProviderV1({ startBehavior: "provider-error" }));
		await rejected.runtime.receiveFrame(initialize);
		await rejected.runtime.receiveFrame(execute);
		await rejected.runtime.waitForIdle();
		expect(rejected.frames.map((frame) => frame.type)).toEqual(["ready", "operation.started", "error"]);
		expect(rejected.frames.at(-1)).toMatchObject({ requestId: execute.requestId, code: "worker_start_failed" });

		const cancelFailed = harness(new FakeWorkerProviderV1({ startBehavior: "pending", cancelFails: true }));
		await cancelFailed.runtime.receiveFrame(initialize);
		await cancelFailed.runtime.receiveFrame(execute);
		await cancelFailed.runtime.receiveFrame({ type: "cancel", requestId: "cancel-failed-1", workerId: binding.workerId, operationId: request.operationId, reason: "cancel" });
		expect(cancelFailed.frames.at(-1)).toMatchObject({ type: "error", requestId: "cancel-failed-1", code: "worker_cancel_failed" });
		cancelFailed.provider.completePending();
		await cancelFailed.runtime.waitForIdle();
		expect(cancelFailed.frames.slice(-2).map((frame) => frame.type)).toEqual(["operation.completed", "receipt"]);
		expect(rejected.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
		expect(cancelFailed.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
	});

	it("reports heartbeat as liveness only, responds to ping, and reclaims the provider", async () => {
		const state = harness();
		await state.runtime.receiveFrame(initialize);
		await state.runtime.emitHeartbeat();
		await state.runtime.receiveFrame({ type: "ping", requestId: "ping-1", workerId: binding.workerId });
		expect(state.frames.slice(1)).toEqual([
			{ type: "heartbeat", workerId: binding.workerId, sequence: 1, at: "2026-08-21T00:00:01.000Z" },
			{ type: "pong", requestId: "ping-1", workerId: binding.workerId, at: "2026-08-21T00:00:01.000Z" },
		]);
		await state.runtime.receiveFrame({ type: "reclaim", requestId: "reclaim-1", workerId: binding.workerId });
		expect(state.provider.disposeCalls).toBe(1);
		expect(state.runtime.closed).toBe(true);

		const failed = harness(new FakeWorkerProviderV1({ disposeThrows: true }));
		await failed.runtime.receiveFrame(initialize);
		await failed.runtime.receiveFrame({ type: "reclaim", requestId: "reclaim-2", workerId: binding.workerId });
		expect(failed.frames.at(-1)).toMatchObject({ type: "error", requestId: "reclaim-2", code: "worker_reclaim_failed" });
		expect(failed.diagnostics.join("")).toBe("[redacted worker diagnostic]\n");
		expect(failed.runtime.closed).toBe(true);
	});

	it("redacts provider throws and keeps stdout frames protocol-only", async () => {
		const state = harness(new FakeWorkerProviderV1({ startBehavior: "throw" }));
		await state.runtime.receiveFrame(initialize);
		await state.runtime.receiveFrame(execute);
		await state.runtime.waitForIdle();
		expect(state.frames.at(-1)).toMatchObject({ type: "error", requestId: execute.requestId, code: "worker_start_failed" });
		const diagnostic = state.diagnostics.join("");
		expect(diagnostic).toBe("[redacted worker diagnostic]\n");
		expect(diagnostic).not.toContain("worker-runtime-secret");
		expect(JSON.stringify(state.frames)).not.toContain("worker-runtime-secret");
	});

	it("runs the stdio entry as bounded JSONL without diagnostic contamination", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const diagnostic = new PassThrough();
		let stdoutText = "";
		let stderrText = "";
		output.setEncoding("utf8");
		diagnostic.setEncoding("utf8");
		output.on("data", (chunk: string) => {
			stdoutText += chunk;
		});
		diagnostic.on("data", (chunk: string) => {
			stderrText += chunk;
		});

		const run = runOperationWorkerProcess({
			provider: new FakeWorkerProviderV1({ startBehavior: "throw" }),
			input,
			output,
			diagnostic,
			now: () => "2026-08-21T00:00:01.000Z",
			heartbeatIntervalMs: 0,
		});
		input.end(`${serializeWorkerFrameLine(initialize)}${serializeWorkerFrameLine(execute)}`);
		await run;

		const frames = stdoutText.trim().split("\n").map((line) => JSON.parse(line) as unknown);
		expect(frames).toEqual([
			expect.objectContaining({ type: "ready" }),
			expect.objectContaining({ type: "operation.started" }),
			expect.objectContaining({ type: "error", code: "worker_start_failed" }),
		]);
		expect(stderrText).toBe("[redacted worker diagnostic]\n");
		expect(stdoutText).not.toContain("worker-runtime-secret");
	});
});
