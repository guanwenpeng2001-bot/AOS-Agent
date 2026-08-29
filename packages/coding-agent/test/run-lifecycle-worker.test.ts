import { fileURLToPath } from "node:url";
import {
	createFoundationToolGateway,
	createHostTerminalGateAuthority,
	createSandboxOperationToolGatewayProvider,
	finalizeRunReceipt,
	settleTaskResult,
	validateAttemptReceiptForProvider,
	validateRunReceipt,
	validateTaskResult,
	type AttemptReceipt,
	type RunReceipt,
	type SandboxOperationRequest,
	type TaskEnvelope,
	type TaskResult,
	type WorkerReceipt,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	createRunLifecycleCoordinator,
	registerRunWorkerLifecycleHooks,
	type RunWorkerLifecycleHooks,
} from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	WorkerSandboxProvider,
	createWorkerRequestFingerprint,
} from "../src/core/worker-sandbox-provider.ts";
import { OperationWorkerSupervisor } from "../src/core/worker-supervisor.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";

const MODEL = { provider: "anthropic", id: "claude-sonnet-5", thinkingLevel: "high" as const };
const CHILD_ENTRY = fileURLToPath(new URL("./fixtures/fake-worker-child.ts", import.meta.url));
const ARTIFACT = {
	schemaVersion: 1 as const,
	artifactId: "artifact-worker-result",
	mediaType: "text/plain",
	digest: `sha256:${"a".repeat(64)}`,
};
const TASK: TaskEnvelope = {
	schemaVersion: 1,
	taskId: "task-1",
	goalId: "goal-1",
	goal: "Prove the Worker evidence chain",
	title: "Worker evidence chain",
	workspace: "workspace-1",
	capabilityRefs: [ARTIFACT],
	inputs: [ARTIFACT],
	expectedOutputs: [ARTIFACT],
	budget: {},
	acceptanceCriteria: [{
		schemaVersion: 1,
		criterionId: "criterion-1",
		description: "Worker evidence is preserved",
		satisfiedBy: "evidence",
		required: true,
	}],
	status: "ready",
	createdAt: "2026-08-21T00:00:00.000Z",
	updatedAt: "2026-08-21T00:00:00.000Z",
};

function operationWorker(runId: string, isRunAccepted: () => boolean = () => true): WorkerSandboxProvider {
	return new WorkerSandboxProvider({
		providerId: "sandbox-worker",
		profile: {
			profileId: "success",
			profileRevision: 1,
			trusted: true,
			supervisor: {
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "success",
				profileRevision: 1,
				capabilities: ["filesystem.read"],
				environment: { AOS_SAFE_TEST_MARKER: "1" },
				readyTimeoutMs: 200,
				heartbeatTimeoutMs: 300,
				cancelTimeoutMs: 120,
				terminateTimeoutMs: 500,
			},
		},
		requireRegisteredPayload: true,
		resolvePreflight: (request: SandboxOperationRequest) => ({
			binding: {
				schemaVersion: 1,
				workerId: `worker-${request.operationId}`,
				providerId: "sandbox-worker",
				sessionId: "session-1",
				laneId: "main",
				runId,
				...(request.bindingId === undefined ? {} : { bindingId: request.bindingId }),
				...(request.bindingEpochId === undefined ? {} : { bindingEpochId: request.bindingEpochId }),
				...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
				profileId: "success",
				profileRevision: 1,
				capabilitySummary: ["filesystem.read"],
				deadlineAt: request.deadlineAt ?? Date.now() + 2_000,
				credentialTargetRefs: [],
				requestFingerprint: createWorkerRequestFingerprint(request),
			},
			runAccepted: isRunAccepted(),
			sessionOwned: true,
			laneOwned: true,
			bindingAuthorized: true,
			policyAuthorized: true,
			sandboxAuthorized: true,
			credentialLeaseActive: true,
		}),
		createSupervisor: (config) => new OperationWorkerSupervisor(config),
	});
}

function attemptReceipt(worker: WorkerReceipt): AttemptReceipt {
	return {
		schemaVersion: 1,
		attemptReceiptId: "attempt-receipt-1",
		taskId: "task-1",
		dispatchId: "dispatch-1",
		attemptId: "attempt-1",
		providerId: "task-executor-1",
		bindingId: "binding-1",
		bindingEpochIds: ["epoch-1"],
		status: "succeeded",
		workerReceiptRefs: [{
			schemaVersion: 1,
			type: "worker_receipt",
			id: worker.workerReceiptId,
			revision: 0,
			providerId: worker.sandboxProviderId,
		}],
		artifacts: [ARTIFACT],
		provenance: {
			producerKind: "scheduler",
			providerId: "task-executor-1",
			producedAt: "2026-08-21T00:00:03.000Z",
			correlation: {
				sessionId: "session-1",
				laneId: "main",
				taskId: "task-1",
				dispatchId: "dispatch-1",
				attemptId: "attempt-1",
				bindingId: "binding-1",
				bindingEpochId: "epoch-1",
				attemptReceiptId: "attempt-receipt-1",
				revision: 1,
			},
		},
		sideEffectState: "none",
	};
}

describe("Run lifecycle Operation Worker wiring", () => {
	it("notifies cancel, deadline, and terminal observers without granting WorkerReceipt terminal authority", async () => {
		const notifications: string[] = [];
		const hooks: RunWorkerLifecycleHooks = {
			onRunCancelRequested: (runId) => notifications.push(`cancel:${runId}`),
			onRunDeadlineExceeded: (runId) => notifications.push(`deadline:${runId}`),
			onRunTerminal: (runId, receipt) => notifications.push(`terminal:${runId}:${receipt.status}`),
		};
		const session = SessionManager.inMemory("/workspace/worker-run");
		const unregister = registerRunWorkerLifecycleHooks(session, hooks);
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const cancelled = coordinator.reserve().accept({ runId: "run-cancel", attempt: 1, model: MODEL });
		cancelled.start();
		cancelled.requestCancel();
		cancelled.requestCancel();
		await observeCanonicalTerminal(session, cancelled, { outcome: "cancelled" });
		expect(cancelled.record.status).toBe("cancelled");

		const deadline = coordinator.reserve().accept({ runId: "run-deadline", attempt: 1, model: MODEL });
		deadline.start();
		deadline.requestDeadlineExceeded();
		await observeCanonicalTerminal(session, deadline, {
			outcome: "failed",
			terminalErrorCode: "run_deadline_exceeded",
		});
		expect(deadline.record.status).toBe("failed");
		expect(deadline.receipt()?.terminalError?.code).toBe("run_deadline_exceeded");
		expect(notifications).toEqual([
			"cancel:run-cancel",
			"terminal:run-cancel:cancelled",
			"deadline:run-deadline",
			"terminal:run-deadline:failed",
		]);
		unregister();
	});

	it("claims Worker hooks by Session identity with token-scoped release", () => {
		const firstSession = SessionManager.inMemory("/workspace/worker-owner-first", { id: "shared-worker-session" });
		const secondSession = SessionManager.inMemory("/workspace/worker-owner-second", { id: "shared-worker-session" });
		const secondInitial = createRunLifecycleCoordinator(secondSession, { diagnostics: () => {} });
		const secondRun = secondInitial.reserve().accept({ runId: "read-only-live-run", attempt: 1, model: MODEL });
		secondRun.start();
		const interrupted: string[] = [];
		const hooks: RunWorkerLifecycleHooks = { onRunInterrupted: (runId) => interrupted.push(runId) };
		const releaseFirst = registerRunWorkerLifecycleHooks(firstSession, hooks);
		expect(() => createRunLifecycleCoordinator(firstSession, {
			diagnostics: () => {},
			workerHooks: {},
		})).toThrow(expect.objectContaining({ code: "service_conflict" }));
		const readOnly = createRunLifecycleCoordinator(secondSession, { diagnostics: () => {} });
		expect(readOnly.rebuildIndex().get("read-only-live-run")?.recovery).toBe("interrupted");
		expect(interrupted).toEqual([]);
		expect(() => createRunLifecycleCoordinator(secondSession, {
			diagnostics: () => {},
			workerHooks: {},
		})).toThrow(expect.objectContaining({ code: "service_conflict" }));
		expect(() => registerRunWorkerLifecycleHooks(firstSession, hooks)).toThrow(
			expect.objectContaining({ code: "service_conflict" }),
		);
		expect(() => registerRunWorkerLifecycleHooks(secondSession, {})).toThrow(
			expect.objectContaining({ code: "service_conflict" }),
		);
		releaseFirst();
		const releaseSecond = registerRunWorkerLifecycleHooks(secondSession, {});
		releaseFirst();
		expect(() => registerRunWorkerLifecycleHooks(firstSession, {})).toThrow(
			expect.objectContaining({ code: "service_conflict" }),
		);
		releaseSecond();
		const releaseAgain = registerRunWorkerLifecycleHooks(firstSession, hooks);
		releaseAgain();
	});

	it("runs accepted through the real ToolGateway and Worker provider before Host-only settlement", async () => {
		const runSession = SessionManager.inMemory("/workspace/worker-success", { id: "session-1" });
		const coordinator = createRunLifecycleCoordinator(runSession, { diagnostics: () => {} });
		const acceptedRun = coordinator.reserve().accept({ runId: "run-success", attempt: 1, model: MODEL });
		acceptedRun.start();
		const workerProvider = operationWorker("run-success", () => coordinator.getRun("run-success")?.record.status === "running");
		workerProvider.bindDurableFactSink("session-1", () => undefined);
		const gateway = createFoundationToolGateway({
			gatewayId: "worker-run-gateway",
			providers: [createSandboxOperationToolGatewayProvider({
				providerId: workerProvider.providerId,
				revision: 1,
				routes: [{ kind: "sandbox", toolName: "read", providerId: workerProvider.providerId, revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } }],
				sandbox: workerProvider,
				capabilities: await workerProvider.capabilities(),
				onOperationPayload: (operationId, payload) => workerProvider.onOperationPayload(operationId, payload),
			})],
		});
		const execute = (operationId: string) => gateway.execute({
			schemaVersion: 1,
			toolCallId: `call-${operationId}`,
			toolName: "read",
			originalArguments: { resource: "filesystem.read", operation: "file.read", path: "README.md" },
			context: {
				schemaVersion: 1,
				operationId,
				bindingId: "binding-1",
				bindingEpochId: "epoch-1",
				taskId: "task-1",
				dispatchId: "dispatch-1",
				attemptId: "attempt-1",
			},
		});
		const execution = await execute("operation-1");
		expect(execution).toMatchObject({ ok: true, value: { ok: true, sideEffectState: "none" } });
		if (!execution.ok || execution.value.toolReceiptRef === undefined) throw new Error("Expected ToolGateway WorkerReceipt reference");
		const worker = workerProvider.getWorkerReceipt(execution.value.toolReceiptRef);
		if (worker === undefined) throw new Error("Expected referenced WorkerReceipt");
		expect(execution.value.toolReceiptRef).toBe(worker.workerReceiptId);
		const attempt = validateAttemptReceiptForProvider(attemptReceipt(worker), {
			providerId: "task-executor-1",
			providerClass: "task_executor",
		});
		expect(attempt).toMatchObject({ ok: true, value: { workerReceiptRefs: [{ id: worker.workerReceiptId }] } });
		expect(validateAttemptReceiptForProvider(attemptReceipt(worker), {
			providerId: "sandbox-worker",
			providerClass: "operation_worker",
		})).toMatchObject({ ok: false, error: { code: "task_executor_invalid_provider_class" } });
		if (!attempt.ok) throw attempt.error;
		const taskResult = settleTaskResult({
			task: TASK,
			taskResultId: "task-result-1",
			receipts: [attempt.value],
			summary: "Worker evidence accepted",
			artifacts: [ARTIFACT],
			tests: [{ name: "worker evidence", required: true, status: "passed", evidenceRefs: [ARTIFACT] }],
			evidence: [{
				schemaVersion: 1,
				factId: "fact-worker-1",
				criterionId: "criterion-1",
				outcome: "satisfied",
				evidenceRefs: [ARTIFACT],
				recordedAt: "2026-08-21T00:00:04.000Z",
			}],
			producer: {
				producerKind: "host",
				providerId: "host-terminal",
				producedAt: "2026-08-21T00:00:05.000Z",
				correlation: { sessionId: "session-1", laneId: "main", taskId: "task-1", taskResultId: "task-result-1", revision: 1 },
			},
		});
		expect(taskResult).toMatchObject({ ok: true, value: { sourceAttemptReceiptIds: [attempt.value.attemptReceiptId] } });
		if (!taskResult.ok) throw taskResult.error;
		const terminal = finalizeRunReceipt({
			runReceiptId: "run-receipt-1",
			runId: "run-success",
			terminalStatus: "completed",
			authority: createHostTerminalGateAuthority("host-terminal"),
			taskResult: taskResult.value,
			attemptReceiptIds: [attempt.value.attemptReceiptId],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			completedAt: "2026-08-21T00:00:06.000Z",
		});
		expect(terminal).toMatchObject({
			ok: true,
			value: {
				runId: "run-success",
				taskResultId: taskResult.value.taskResultId,
				attemptReceiptIds: [attempt.value.attemptReceiptId],
			},
		});

		const forgedAttempt = worker as unknown as AttemptReceipt;
		expect(validateAttemptReceiptForProvider(forgedAttempt, {
			providerId: worker.sandboxProviderId,
			providerClass: "operation_worker",
		})).toMatchObject({ ok: false });
		expect(settleTaskResult({
			task: TASK,
			taskResultId: "task-result-forged",
			receipts: [forgedAttempt],
			summary: "forged",
			artifacts: [ARTIFACT],
			tests: [{ name: "worker evidence", required: true, status: "passed", evidenceRefs: [ARTIFACT] }],
			evidence: [{ schemaVersion: 1, factId: "fact-forged", criterionId: "criterion-1", outcome: "satisfied", evidenceRefs: [ARTIFACT], recordedAt: "2026-08-21T00:00:04.000Z" }],
			producer: { producerKind: "host", providerId: "host-terminal", producedAt: "2026-08-21T00:00:05.000Z", correlation: { sessionId: "session-1", laneId: "main", taskId: "task-1", taskResultId: "task-result-forged", revision: 1 } },
		})).toMatchObject({ ok: false });
		expect(validateTaskResult(worker as unknown as TaskResult)).toMatchObject({ ok: false });
		expect(finalizeRunReceipt({
			runReceiptId: "run-receipt-forged",
			runId: "run-success",
			terminalStatus: "completed",
			authority: createHostTerminalGateAuthority("host-terminal"),
			taskResult: worker as unknown as TaskResult,
			attemptReceiptIds: [attempt.value.attemptReceiptId],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		})).toMatchObject({ ok: false });
		expect(validateRunReceipt(worker as unknown as RunReceipt)).toMatchObject({ ok: false });
		await gateway.dispose();
	});

	it("notifies interrupted recovery while the default coordinator has no Worker side effects", async () => {
		const session = SessionManager.inMemory("/workspace/worker-recovery");
		const initial = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const run = initial.reserve().accept({ runId: "run-interrupted", attempt: 1, model: MODEL });
		run.start();
		const interrupted: string[] = [];
		const recovered = createRunLifecycleCoordinator(session, {
			diagnostics: () => {},
			workerHooks: { onRunInterrupted: (runId) => interrupted.push(runId) },
		});
		expect(recovered.rebuildIndex().get("run-interrupted")?.recovery).toBe("interrupted");
		expect(interrupted).toEqual(["run-interrupted"]);

		const defaultSession = SessionManager.inMemory("/workspace/default-run");
		const defaultCoordinator = createRunLifecycleCoordinator(defaultSession, {
			diagnostics: () => {},
		});
		const defaultRun = defaultCoordinator.reserve().accept({ runId: "run-default", attempt: 1, model: MODEL });
		defaultRun.start();
		defaultRun.requestCancel();
		await observeCanonicalTerminal(defaultSession, defaultRun, { outcome: "cancelled" });
		expect(defaultRun.record.status).toBe("cancelled");
	});
});
