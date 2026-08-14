import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@aos-agent/ai";
import {
	classifyHarnessProviderError,
	createHarnessCancellation,
	createHarnessProviderContext,
	decideHarnessRetry,
	HarnessDeadlineExceeded,
	invokeHarnessProvider,
	type HarnessOperationContext,
} from "../../src/harness/types.ts";
import {
	advanceLoopConvergence,
	createLoopConvergenceState,
	reduceLaneState,
	type EffectiveLaneConfiguration,
	type LaneReductionInput,
} from "../../src/harness/reducer.ts";
import { HarnessEventBus } from "../../src/harness/events.ts";
import type {
	Entry,
	LaneRecord,
	MessageEntry,
	OperationStartedRecord,
	StepAttemptRecord,
} from "../../src/harness/session/types.ts";

const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
const defaults: EffectiveLaneConfiguration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function providerError(message: string, status: number): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

function toolCall(name: string, arguments_: Record<string, unknown>, id = "provider-id") {
	return { type: "toolCall" as const, id, name, arguments: arguments_, namespace: undefined };
}

function operationStart(
	intent: OperationStartedRecord["intent"] = { kind: "run", originalPrompt: [], initialMessages: [] },
): OperationStartedRecord {
	return {
		type: "operation_started",
		id: "operation-1",
		lane: "main",
		seq: 1,
		timestamp: 1,
		sourceLeafId: "branch-1",
		intent,
	};
}

function attempt(resultEntryId: string, attemptNumber = 2): StepAttemptRecord {
	return {
		type: "step_attempt",
		id: `attempt-${attemptNumber}`,
		lane: "main",
		seq: 2,
		timestamp: 2,
		runId: "operation-1",
		step: "assistant",
		attempt: attemptNumber,
		resultEntryId,
	};
}

function assistantEntry(
	id: string,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): MessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		seq: 3,
		timestamp: 3,
		message: {
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "provider",
			model: "model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 3,
		},
	};
}

function reductionInput(records: readonly LaneRecord[], ownEntries: readonly Entry[] = []): LaneReductionInput {
	return {
		lane: "main",
		openOperations: [operationStart()],
		records,
		entries: ownEntries,
		leafId: ownEntries.at(-1)?.id ?? null,
		ownEntries,
		configurationEntries: [],
		defaults,
	};
}

describe("harness remote-ready kernel contracts", () => {
	it("stops a repeated tool-call loop using a stable fingerprint, not provider call ids", () => {
		let state = createLoopConvergenceState({ maxIterations: 10, maxDuplicateToolCalls: 2 });
		let result = advanceLoopConvergence(state, { toolCalls: [toolCall("read", { b: 2, a: 1 }, "first")] });
		state = result.state;
		expect(result.decision.stop).toBe(false);

		result = advanceLoopConvergence(state, { toolCalls: [toolCall("read", { a: 1, b: 2 }, "second")] });
		expect(result.decision).toMatchObject({ stop: true, reason: "duplicate_tool_call" });
		expect(result.decision.fingerprint).toContain('read:{"a":1,"b":2}');
	});

	it("enforces an explicit iteration ceiling and identifies no-progress loops", () => {
		let state = createLoopConvergenceState({ maxIterations: 2, maxNoProgressIterations: 4 });
		let result = advanceLoopConvergence(state, { madeProgress: true, progressToken: "one" });
		result = advanceLoopConvergence(result.state, { madeProgress: true, progressToken: "two" });
		expect(result.decision).toMatchObject({ stop: true, iteration: 2, reason: "max_iterations" });

		state = createLoopConvergenceState({ maxIterations: 10, maxNoProgressIterations: 2 });
		result = advanceLoopConvergence(state, { madeProgress: false });
		result = advanceLoopConvergence(result.state, { madeProgress: false });
		expect(result.decision).toMatchObject({ stop: true, reason: "dead_loop" });
	});

	it("reuses bounded retry policy only for safe transient failures", () => {
		const transient = classifyHarnessProviderError(providerError("service unavailable", 503));
		expect(transient).toMatchObject({ category: "transient", safeToRetry: true, status: 503 });
		expect(decideHarnessRetry(transient, { policy, retriesUsed: 0 })).toMatchObject({
			retry: true,
			reason: "retry",
		});

		const permission = classifyHarnessProviderError(providerError("permission denied", 403), {
			operation: "mcp",
		});
		expect(decideHarnessRetry(permission, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "permission",
		});

		const parameter = classifyHarnessProviderError(providerError("invalid parameter", 400), {
			operation: "model",
		});
		expect(decideHarnessRetry(parameter, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "parameter",
		});

		const unknownSideEffect = classifyHarnessProviderError(providerError("timeout after dispatch", 503), {
			operation: "sandbox",
			phase: "after_request",
		});
		expect(unknownSideEffect.category).toBe("side_effect_unknown");
		expect(decideHarnessRetry(unknownSideEffect, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "side_effect_unknown",
		});

		const safeTool = classifyHarnessProviderError(providerError("timeout", 503), {
			operation: "tool",
			phase: "after_request",
			sideEffect: "idempotent",
		});
		expect(decideHarnessRetry(safeTool, { policy, retriesUsed: 0, replay: "safe" })).toMatchObject({
			retry: true,
			reason: "retry",
		});

		const deadline = classifyHarnessProviderError(new HarnessDeadlineExceeded(100));
		expect(deadline).toMatchObject({ category: "deadline", safeToRetry: false });
		expect(decideHarnessRetry(deadline, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "deadline",
		});
	});

	it("treats cancellation as terminal and propagates the same signal to every provider kind", async () => {
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));
		const cancelled = classifyHarnessProviderError(new Error("request stopped"), { signal: controller.signal });
		expect(decideHarnessRetry(cancelled, { policy, retriesUsed: 0, signal: controller.signal })).toMatchObject({
			retry: false,
			reason: "cancelled",
		});

		const operation: HarnessOperationContext = {
			operationId: "operation-1",
			operationKind: "run",
			branchId: "branch-1",
			checkpointId: "checkpoint-1",
			attempt: 3,
		};
		const activeController = new AbortController();
		for (const provider of ["model", "tool", "mcp", "sandbox"] as const) {
			const context = createHarnessProviderContext(
				operation,
				{ signal: activeController.signal, deadlineAt: 100 },
				provider,
			);
			await expect(invokeHarnessProvider(async (_input, received) => received, undefined, context)).resolves.toMatchObject({
				provider,
				signal: activeController.signal,
				deadlineAt: 100,
				operationId: "operation-1",
				checkpointId: "checkpoint-1",
			});
		}
	});

	it("aborts provider callbacks at a shared deadline and cleans up the timer", () => {
		vi.useFakeTimers();
		try {
			const cancellation = createHarnessCancellation({ deadlineMs: 100, now: () => 1_000 });
			expect(cancellation.signal?.aborted).toBe(false);
			vi.advanceTimersByTime(100);
			expect(cancellation.signal?.aborted).toBe(true);
			expect(cancellation.signal?.reason).toBeInstanceOf(HarnessDeadlineExceeded);
			cancellation.cleanup();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps operation associations on remote-ready lifecycle events", () => {
		const events = new HarnessEventBus();
		const received: string[] = [];
		events.on("run_start", (event) => {
			received.push(`${event.operationId}:${event.branchId}:${event.checkpointId}:${event.attempt}`);
		});
		events.on("run_end", (event) => {
			received.push(`${event.operationId}:${event.resumeBoundary}`);
		});
		events.emit({
			type: "run_start",
			lane: "main",
			runId: "run-1",
			operationId: "operation-1",
			branchId: "branch-1",
			checkpointId: "checkpoint-1",
			attempt: 2,
		});
		events.emit({
			type: "run_end",
			lane: "main",
			runId: "run-1",
			outcome: "aborted",
			leafId: "leaf-1",
			operationId: "operation-1",
			resumeBoundary: "aborting",
		});
		expect(received).toEqual(["operation-1:branch-1:checkpoint-1:2", "operation-1:aborting"]);
	});

	it("preserves durable operation, branch, attempt, and checkpoint associations at resume boundaries", () => {
		const result = reduceLaneState(
			reductionInput([
				operationStart(),
				attempt("discarded-checkpoint", 1),
				{ ...attempt("assistant-checkpoint", 2), seq: 3, timestamp: 3 },
			]),
		);
		expect(result.laneState.operation?.resumeBoundary).toEqual({
			operationId: "operation-1",
			operationKind: "run",
			branchId: "branch-1",
			checkpointId: "assistant-checkpoint",
			attempt: 2,
			status: "awaiting_checkpoint",
		});

		const assistant = assistantEntry("assistant-tools", [toolCall("write", { path: "file" })]);
		const awaitingTool = reduceLaneState(
			reductionInput(
				[operationStart(), { ...attempt(assistant.id, 1), seq: 2, timestamp: 2 }],
				[assistant],
			),
		);
		expect(awaitingTool.laneState.operation?.resumeBoundary).toMatchObject({
			operationId: "operation-1",
			branchId: "branch-1",
			checkpointId: "assistant-tools",
			attempt: 1,
			status: "awaiting_tool_results",
		});
	});
});
