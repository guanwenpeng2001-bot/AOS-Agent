import { describe, expect, it } from "vitest";
import { createBindingHandle, createRunBindingAssociation } from "../src/core/binding-handles.ts";
import {
	decodeLegacyAutomationRunLedgerEntryV1,
	migrateLegacyAutomationRunLedgerV1,
	planLegacyAutomationRunLedgerMigrationV1,
	type LegacyAutomationRunLedgerSourceEntryV1,
} from "../src/core/migrations/automation-run-ledger.ts";
import { PrivateMigrationError } from "../src/core/migrations/session-entry.ts";

const SESSION_ID = "session-1";
const RUN_ID = "run-1";

function accepted(bindingAssociation = createRunBindingAssociation(RUN_ID, [
	createBindingHandle({
		domain: "model",
		bindingId: "model-binding-1",
		revision: "revision-1",
		relation: "run.model",
	}),
])) {
	return {
		schemaVersion: 1 as const,
		kind: "accepted" as const,
		record: {
			id: RUN_ID,
			sessionId: SESSION_ID,
			attempt: 0,
			status: "accepted" as const,
			model: { provider: "test", id: "model", thinkingLevel: "medium" as const },
			bindingAssociation,
		},
	};
}

function started() {
	return {
		schemaVersion: 1 as const,
		kind: "started" as const,
		runId: RUN_ID,
		startedAt: "2026-01-01T00:00:01.000Z",
	};
}

function terminal(status: "completed" | "failed" | "cancelled" = "completed") {
	return {
		schemaVersion: 1 as const,
		kind: "terminal" as const,
		receipt: {
			runId: RUN_ID,
			sessionId: SESSION_ID,
			status,
			...(status === "completed" ? { finalText: "done" } : {}),
			usage: { input: 1, output: 2, total: 3 },
			...(status === "failed"
				? { terminalError: { code: "model_error", message: "failed", retryable: false } }
				: {}),
		},
		endedAt: "2026-01-01T00:00:02.000Z",
	};
}

function source(sequence: number, entryId: string, data: unknown): LegacyAutomationRunLedgerSourceEntryV1 {
	return { sequence, entryId, data };
}

describe("private automation.run ledger migration", () => {
	it("replays accepted, started, and terminal facts in deterministic ledger order", () => {
		const entries = [
			source(3, "terminal", terminal()),
			source(1, "accepted", accepted()),
			source(2, "started", started()),
			source(4, "terminal-replay", terminal()),
		];
		const result = migrateLegacyAutomationRunLedgerV1(SESSION_ID, entries);
		const reversedPlan = planLegacyAutomationRunLedgerMigrationV1(SESSION_ID, [...entries].reverse());
		const plan = planLegacyAutomationRunLedgerMigrationV1(SESSION_ID, entries);

		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]).toMatchObject({
			runId: RUN_ID,
			status: "completed",
			startedAt: "2026-01-01T00:00:01.000Z",
			endedAt: "2026-01-01T00:00:02.000Z",
			terminal: { status: "completed", finalText: "done" },
		});
		expect(result.runs[0]?.bindingAssociationView?.runId).toBe(RUN_ID);
		expect(result.runs[0]?.terminal).not.toHaveProperty("bindingAssociation");
		expect(result.runs[0]).not.toHaveProperty("recovery");
		expect(reversedPlan).toEqual(plan);
	});

	it("treats equivalent accepted and started duplicates as no-ops", () => {
		const result = migrateLegacyAutomationRunLedgerV1(SESSION_ID, [
			source(1, "accepted-a", accepted()),
			source(2, "accepted-b", accepted()),
			source(3, "started-a", started()),
			source(4, "started-b", started()),
		]);
		expect(result.runs).toEqual([
			expect.objectContaining({ runId: RUN_ID, status: "running", recovery: "interrupted" }),
		]);
	});

	it("fails closed on conflicting terminal facts", () => {
		expect(() =>
			migrateLegacyAutomationRunLedgerV1(SESSION_ID, [
				source(1, "accepted", accepted()),
				source(2, "completed", terminal("completed")),
				source(3, "failed", terminal("failed")),
			]),
		).toThrow("terminal fact conflicts");
	});

	it("fails closed on orphan facts, duplicate order, and non-exact historical shapes", () => {
		expect(() =>
			migrateLegacyAutomationRunLedgerV1(SESSION_ID, [source(1, "started", started())]),
		).toThrow("orphaned");
		expect(() =>
			migrateLegacyAutomationRunLedgerV1(SESSION_ID, [
				source(1, "accepted", accepted()),
				source(1, "started", started()),
			]),
		).toThrow("repeats sequence");
		expect(() =>
			decodeLegacyAutomationRunLedgerEntryV1({ ...started(), lifecycleClaim: "running" }),
		).toThrow(PrivateMigrationError);
		expect(() =>
			decodeLegacyAutomationRunLedgerEntryV1({
				...accepted(),
				record: { ...accepted().record, status: "completed" },
			}),
		).toThrow("accepted-state invariants");
	});
});
