import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	createHostTerminalGateAuthority,
	LayeredResultSettlement,
	SessionLedger,
	type AttemptReceipt,
	type TaskEnvelope,
	type TaskResult,
} from "../../src/harness/foundation/index.ts";
import { InMemorySessionStorage, JsonlSessionRepo, Session } from "../../src/harness/session/index.ts";

const now = "2026-01-01T00:00:00.000Z";
const runUsage = { inputTokens: 7, outputTokens: 10, totalTokens: 20 } as const;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "aos-agent-t2-run-authority-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function task(sessionId: string): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: `task-${sessionId}`,
		goalId: `goal-${sessionId}`,
		goal: "exercise the canonical Host terminal gate",
		workspace: "workspace-t2",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: now,
		updatedAt: now,
	};
}

function attemptReceipt(
	sessionId: string,
	status: AttemptReceipt["status"],
	sideEffectState: AttemptReceipt["sideEffectState"] = "none",
): AttemptReceipt {
	const taskId = `task-${sessionId}`;
	const attemptReceiptId = `attempt-receipt-${sessionId}`;
	const dispatchId = `dispatch-${sessionId}`;
	const attemptId = `attempt-${sessionId}`;
	const bindingId = `binding-${sessionId}`;
	const bindingEpochId = `binding-epoch-${sessionId}`;
	return {
		schemaVersion: 1,
		attemptReceiptId,
		taskId,
		dispatchId,
		attemptId,
		providerId: "scheduler-t2",
		bindingId,
		bindingEpochIds: [bindingEpochId],
		status,
		workerReceiptRefs: [],
		artifacts: [],
		...(status === "succeeded" ? {} : { error: { code: status === "cancelled" ? "user_aborted" : sideEffectState === "none" ? "agent_run_failed" : "side_effect_unknown", message: "safe terminal failure", retryable: false } }),
		provenance: {
			producerKind: "scheduler",
			providerId: "scheduler-t2",
			producedAt: now,
			correlation: { sessionId, laneId: "main", taskId, dispatchId, attemptId, bindingId, bindingEpochId, attemptReceiptId, revision: 1 },
		},
		sideEffectState,
	};
}

async function seedTaskAndAttemptReceipt(
	session: Session,
	sessionId: string,
	status: AttemptReceipt["status"],
	sideEffectState: AttemptReceipt["sideEffectState"] = "none",
): Promise<{ readonly task: TaskEnvelope; readonly attemptReceipt: AttemptReceipt }> {
	const taskValue = task(sessionId);
	const receipt = attemptReceipt(sessionId, status, sideEffectState);
	const ledger = new SessionLedger(session, { ownerId: `seed-${sessionId}` });
	await ledger.appendFact("task", taskValue.taskId, taskValue, { clientRequestId: `seed:task:${taskValue.taskId}`, expectedRevision: 0, correlation: { taskId: taskValue.taskId, goalId: taskValue.goalId } });
	await ledger.appendFact("attempt_receipt", receipt.attemptReceiptId, receipt, { clientRequestId: `seed:attempt-receipt:${receipt.attemptReceiptId}`, expectedRevision: 0, correlation: { taskId: receipt.taskId, dispatchId: receipt.dispatchId, attemptId: receipt.attemptId, attemptReceiptId: receipt.attemptReceiptId, bindingId: receipt.bindingId, bindingEpochId: receipt.bindingEpochIds[0] } });
	await ledger.release();
	return { task: taskValue, attemptReceipt: receipt };
}

async function settleTask(
	settlement: LayeredResultSettlement,
	sessionId: string,
	taskValue: TaskEnvelope,
	receipt: AttemptReceipt,
): Promise<TaskResult> {
	const taskResultId = `task-result-${sessionId}`;
	const settled = await settlement.settle({
		taskResultId,
		task: taskValue,
		sourceAttemptReceiptIds: [receipt.attemptReceiptId],
		summary: "canonical task result",
		artifacts: [],
		tests: [],
		evidence: [],
		producer: { producerKind: "host", providerId: "host-t2", producedAt: now, correlation: { sessionId, laneId: "main", taskId: taskValue.taskId, taskResultId, attemptReceiptId: receipt.attemptReceiptId, revision: 1 } },
	});
	if (!settled.ok) throw settled.error;
	return settled.value;
}

function sourceFiles(root: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
	}
	return files.sort();
}

describe("T2 Foundation Run terminal authority", () => {
	it.each([
		{ name: "completed", receiptStatus: "succeeded" as const, terminalStatus: "completed" as const, terminalErrorCode: undefined },
		{ name: "failed", receiptStatus: "failed" as const, terminalStatus: "failed" as const, terminalErrorCode: "agent_run_failed" },
		{ name: "cancelled", receiptStatus: "cancelled" as const, terminalStatus: "cancelled" as const, terminalErrorCode: "user_aborted" },
	])("writes one canonical $name receipt and stable terminal event", async ({ name, receiptStatus, terminalStatus, terminalErrorCode }) => {
		const sessionId = `t2-${name}`;
		const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
		const fixture = await seedTaskAndAttemptReceipt(session, sessionId, receiptStatus);
		const settlement = new LayeredResultSettlement(session, { ownerId: `settlement-${sessionId}` });
		const taskResult = await settleTask(settlement, sessionId, fixture.task, fixture.attemptReceipt);
		const input = {
			runReceiptId: `run-receipt-${sessionId}`,
			runId: `run-${sessionId}`,
			terminalStatus,
			authority: createHostTerminalGateAuthority("host-t2"),
			attemptReceiptIds: [fixture.attemptReceipt.attemptReceiptId],
			taskResultId: taskResult.taskResultId,
			usage: runUsage,
			...(terminalErrorCode === undefined ? {} : { terminalErrorCode }),
			completedAt: now,
		};
		const [first, duplicate] = await Promise.all([settlement.finalize(input), settlement.finalize(input)]);
		expect(first).toMatchObject({ ok: true, value: { terminalStatus, usage: runUsage, completedAt: now } });
		expect(duplicate).toEqual(first);
		if (!first.ok) throw first.error;
		if (terminalErrorCode === undefined) {
			expect(first.value.terminalError).toBeUndefined();
		} else {
			expect(first.value.terminalErrorCode).toBe(terminalErrorCode);
			expect(first.value.terminalError).toEqual(fixture.attemptReceipt.error);
		}
		expect(await settlement.getRunReceipt(first.value.runReceiptId)).toEqual(first.value);
		expect(await settlement.getRunReceiptByRunId(first.value.runId)).toEqual(first.value);
		const canonical = await settlement.lookupCanonicalRun(first.value.runId);
		expect(canonical).toMatchObject({ ok: true, value: { runReceipt: first.value, taskResult, attemptReceipts: [fixture.attemptReceipt], writtenEvent: { category: "run_receipt.written", payload: { runReceiptId: first.value.runReceiptId, runId: first.value.runId }, correlation: { sessionId, laneId: "main", taskId: fixture.task.taskId, runId: first.value.runId, runReceiptId: first.value.runReceiptId, taskResultId: taskResult.taskResultId, attemptId: fixture.attemptReceipt.attemptId, attemptReceiptId: fixture.attemptReceipt.attemptReceiptId } } } });
		const event = await settlement.getRunReceiptWrittenEvent(first.value.runId);
		expect(event).toEqual(canonical.ok ? canonical.value?.writtenEvent : undefined);
		expect(event?.eventId).toBeTruthy();
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(1);
		await settlement.release();
	});

	it("fails side-effect-unknown closed until the Host writes the canonical failed terminal", async () => {
		const sessionId = "t2-side-effect-unknown";
		const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
		const fixture = await seedTaskAndAttemptReceipt(session, sessionId, "failed", "side_effect_unknown");
		const settlement = new LayeredResultSettlement(session, { ownerId: `settlement-${sessionId}` });
		const taskResult = await settleTask(settlement, sessionId, fixture.task, fixture.attemptReceipt);
		const base = { runReceiptId: `run-receipt-${sessionId}`, runId: `run-${sessionId}`, authority: createHostTerminalGateAuthority("host-t2"), attemptReceiptIds: [fixture.attemptReceipt.attemptReceiptId], taskResultId: taskResult.taskResultId, usage: runUsage, completedAt: now };
		expect(await settlement.finalize({ ...base, terminalStatus: "cancelled", terminalErrorCode: "user_aborted" })).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(0);
		expect(await settlement.finalize({ ...base, terminalStatus: "failed", terminalErrorCode: "agent_run_failed" })).toMatchObject({ ok: true, value: { terminalStatus: "failed", terminalErrorCode: "side_effect_unknown", terminalError: { code: "side_effect_unknown", category: "side_effect_unknown", retryable: false }, usage: runUsage } });
		await settlement.release();
	});

	it("rejects out-of-order and conflicting terminals without consuming the canonical identity", async () => {
		const sessionId = "t2-terminal-order";
		const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
		const settlement = new LayeredResultSettlement(session, { ownerId: `settlement-${sessionId}` });
		const base = { runReceiptId: `run-receipt-${sessionId}`, runId: `run-${sessionId}`, terminalStatus: "completed" as const, authority: createHostTerminalGateAuthority("host-t2"), attemptReceiptIds: [`attempt-receipt-${sessionId}`], taskResultId: `task-result-${sessionId}`, usage: runUsage, completedAt: now };
		expect(await settlement.finalize(base)).toMatchObject({ ok: false, error: { code: "task_result_no_source_receipts" } });
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(0);
		const fixture = await seedTaskAndAttemptReceipt(session, sessionId, "succeeded");
		const taskResult = await settleTask(settlement, sessionId, fixture.task, fixture.attemptReceipt);
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, terminalErrorCode: "impossible_completed_error" })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, terminalStatus: "failed" })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 0 } })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		const accepted = await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId });
		expect(accepted).toMatchObject({ ok: true });
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, runReceiptId: "conflicting-receipt", terminalStatus: "failed", terminalErrorCode: "agent_run_failed" })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(await settlement.finalize({ ...base, taskResultId: taskResult.taskResultId, runId: "conflicting-run", terminalStatus: "failed", terminalErrorCode: "agent_run_failed" })).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(1);
		await settlement.release();
	});

	it("replays the post-receipt crash boundary after JSONL restart without a new timestamp or event", async () => {
		const root = temporaryDirectory();
		const sessionId = "t2-restart-replay";
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const session = await repo.create({ id: sessionId, cwd: root });
		const fixture = await seedTaskAndAttemptReceipt(session, sessionId, "succeeded");
		const firstSettlement = new LayeredResultSettlement(session, { ownerId: `settlement-${sessionId}-first` });
		const taskResult = await settleTask(firstSettlement, sessionId, fixture.task, fixture.attemptReceipt);
		const input = { runReceiptId: `run-receipt-${sessionId}`, runId: `run-${sessionId}`, terminalStatus: "completed" as const, authority: createHostTerminalGateAuthority("host-t2"), attemptReceiptIds: [fixture.attemptReceipt.attemptReceiptId], taskResultId: taskResult.taskResultId, usage: runUsage };
		const first = await firstSettlement.finalize(input);
		if (!first.ok) throw first.error;
		const firstEvent = await firstSettlement.getRunReceiptWrittenEvent(input.runId);
		await firstSettlement.release();
		const reopened = await repo.open(await session.getMetadata());
		const restartedSettlement = new LayeredResultSettlement(reopened, { ownerId: `settlement-${sessionId}-restart` });
		const replayed = await restartedSettlement.finalize(input);
		expect(replayed).toEqual(first);
		expect(replayed).toMatchObject({ ok: true, value: { completedAt: first.value.completedAt } });
		expect(await restartedSettlement.getRunReceiptWrittenEvent(input.runId)).toEqual(firstEvent);
		expect(await restartedSettlement.lookupCanonicalRun(input.runId)).toMatchObject({ ok: true, value: { runReceipt: first.value, taskResult, attemptReceipts: [fixture.attemptReceipt], writtenEvent: firstEvent } });
		expect(await reopened.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(1);
		await restartedSettlement.release();
	});

	it("keeps finalizeRunReceipt and the durable RunReceipt write behind one source authority", () => {
		const root = resolve(import.meta.dirname, "../../src");
		const sources = sourceFiles(root).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));
		const finalizerOccurrences = sources.flatMap((source) => [...source.text.matchAll(/\bfinalizeRunReceipt\s*\(/g)].map(() => source.path));
		expect(finalizerOccurrences).toEqual(["harness/foundation/results.ts", "harness/foundation/settlement.ts"]);
		const durableWriters = sources.flatMap((source) => [...source.text.matchAll(/\b(?:appendFact|persistFact)\s*\(\s*["']run_receipt["']/g)].map(() => source.path));
		expect(durableWriters).toEqual(["harness/foundation/settlement.ts"]);
	});
});
