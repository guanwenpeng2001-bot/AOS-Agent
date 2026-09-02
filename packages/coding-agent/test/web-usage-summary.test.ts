import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditQuery, AuditQueryResult } from "../src/modes/rpc/rpc-types.ts";
import { loadWebUsageSummary } from "../src/modes/web/usage-summary.ts";

const WARNING = { code: "unknown_source" as const, sessionId: "session-a" };

const EVENTS = [
	terminalEvent("terminal-1", "session-a", "run-1", "2026-09-01T12:00:00.000Z", 100, 20, 120),
	modelAttemptEvent("attempt-1-started", "session-a", "run-1", "attempt-1", "model-a", "started"),
	modelAttemptEvent("attempt-1-completed", "session-a", "run-1", "attempt-1", "model-a", "completed", {
		inputTokens: 60,
		outputTokens: 10,
		totalTokens: 70,
		costUsd: 0.25,
	}),
	modelAttemptEvent("attempt-2", "session-a", "run-1", "attempt-2", "model-b", "completed", {
		inputTokens: 40,
		outputTokens: 10,
		totalTokens: 50,
		costUsd: 0.5,
	}),
	terminalEvent("terminal-2", "session-a", "run-2", "2026-09-02T10:00:00.000Z", 30, 5, 35),
	modelAttemptEvent("attempt-3", "session-a", "run-2", "attempt-3", "model-a", "completed", {
		inputTokens: 30,
		outputTokens: 5,
		totalTokens: 35,
		costUsd: 0.125,
	}),
	terminalEvent("terminal-3", "session-b", "run-3", "2026-09-02T11:00:00.000Z", 10, 2, 12, {
		provider: "legacy-provider",
		modelId: "legacy-model",
		costUsd: 0.0625,
	}),
] satisfies ReadonlyArray<AuditEvent>;

describe("Web usage summary", () => {
	it("paginates fake audit data and aggregates receipt usage by Session, model, and UTC day", async () => {
		const auditQuery = vi.fn(async (query: AuditQuery): Promise<AuditQueryResult> =>
			query.cursor === undefined
				? auditResult(EVENTS.slice(0, 4), "page-2")
				: auditResult(EVENTS.slice(4), undefined),
		);

		const result = await loadWebUsageSummary({ auditQuery });

		expect(auditQuery).toHaveBeenNthCalledWith(1, {
			scope: "session-directory",
			types: ["run.completed", "run.failed", "run.cancelled", "model.attempt"],
			limit: 200,
		});
		expect(auditQuery).toHaveBeenNthCalledWith(2, {
			scope: "session-directory",
			types: ["run.completed", "run.failed", "run.cancelled", "model.attempt"],
			limit: 200,
			cursor: "page-2",
		});
		expect(result.totals).toEqual({
			runCount: 3,
			inputTokens: 140,
			outputTokens: 27,
			totalTokens: 167,
			costUsd: 0.9375,
		});
		expect(result.bySession).toEqual([
			{
				sessionId: "session-a",
				runCount: 2,
				inputTokens: 130,
				outputTokens: 25,
				totalTokens: 155,
				costUsd: 0.875,
			},
			{
				sessionId: "session-b",
				runCount: 1,
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				costUsd: 0.0625,
			},
		]);
		expect(result.byModel).toEqual([
			{
				provider: "test-provider",
				modelId: "model-a",
				runCount: 2,
				inputTokens: 90,
				outputTokens: 15,
				totalTokens: 105,
				costUsd: 0.375,
			},
			{
				provider: "test-provider",
				modelId: "model-b",
				runCount: 1,
				inputTokens: 40,
				outputTokens: 10,
				totalTokens: 50,
				costUsd: 0.5,
			},
			{
				provider: "legacy-provider",
				modelId: "legacy-model",
				runCount: 1,
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				costUsd: 0.0625,
			},
		]);
		expect(result.byDay).toEqual([
			{
				day: "2026-09-02",
				runCount: 2,
				inputTokens: 40,
				outputTokens: 7,
				totalTokens: 47,
				costUsd: 0.1875,
			},
			{
				day: "2026-09-01",
				runCount: 1,
				inputTokens: 100,
				outputTokens: 20,
				totalTokens: 120,
				costUsd: 0.75,
			},
		]);
		expect(result.warningCount).toBe(1);
	});
});

function terminalEvent(
	eventId: string,
	sessionId: string,
	runId: string,
	recordedAt: string,
	input: number,
	output: number,
	total: number,
	model?: { readonly provider: string; readonly modelId: string; readonly costUsd: number },
): AuditEvent {
	return {
		schemaVersion: 1,
		eventId,
		recordedAt,
		sessionId,
		sourceEntryId: eventId,
		type: "run.completed",
		runId,
		summary: {
			status: "completed",
			endedAt: recordedAt,
			usage: { input, output, total },
			...(model === undefined
				? {}
				: {
						finalModel: { provider: model.provider, modelId: model.modelId },
						modelBudget: { costUsd: model.costUsd },
					}),
		},
	};
}

function modelAttemptEvent(
	eventId: string,
	sessionId: string,
	runId: string,
	attemptId: string,
	modelId: string,
	status: "started" | "completed",
	usage?: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly totalTokens: number;
		readonly costUsd: number;
	},
): AuditEvent {
	const recordedAt = status === "started" ? "2026-09-01T09:00:00.000Z" : "2026-09-01T09:01:00.000Z";
	return {
		schemaVersion: 1,
		eventId,
		recordedAt,
		sessionId,
		sourceEntryId: eventId,
		type: "model.attempt",
		runId,
		summary: {
			attemptId,
			bindingId: `binding-${attemptId}`,
			candidate: { provider: "test-provider", modelId },
			order: 0,
			status,
			startedAt: "2026-09-01T09:00:00.000Z",
			...(status === "completed" ? { endedAt: recordedAt } : {}),
			...(usage === undefined ? {} : { usage }),
		},
	};
}

function auditResult(events: ReadonlyArray<AuditEvent>, nextCursor: string | undefined): AuditQueryResult {
	return {
		schemaVersion: 1,
		scope: "session-directory",
		events,
		...(nextCursor === undefined ? {} : { nextCursor }),
		warnings: [WARNING],
		integrity: {
			schemaVersion: 1,
			status: "legacy",
			cursorProtection: "injected",
			sessions: [],
		},
	};
}
