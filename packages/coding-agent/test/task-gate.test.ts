import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	TASK_GATE_CUSTOM_TYPE,
	TaskGateError,
	TaskGateStore,
	foldTaskGateEntries,
	isTaskGateRecord,
	isTaskGateTransition,
	taskGateActionForStatus,
	taskGateCommandType,
	type TaskGateStatus,
} from "../src/core/task-gate.ts";

const NOW = "2026-08-15T12:00:00.000Z";

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/task-gate");
}

function makeStore(session: SessionManager, diagnostics?: (warning: { code: string }) => void): TaskGateStore {
	let next = 0;
	return new TaskGateStore(session, {
		now: () => NOW,
		createGateId: () => `gate_${String(++next).padStart(3, "0")}`,
		...(diagnostics === undefined ? {} : { diagnostics }),
	});
}

function request(
	overrides: Partial<{
		taskId: string;
		stageId: string;
		stageRevision: number;
		runId: string;
		clientRequestId: string;
	}> = {},
) {
	return {
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		clientRequestId: "req-1",
		...overrides,
	};
}

function decide(gateId: string, clientRequestId: string, overrides: Partial<{ actorId: string; reasonCode: string }> = {}) {
	return { gateId, clientRequestId, ...overrides };
}

function expectGateError(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(TaskGateError);
		expect((error as TaskGateError).code).toBe(code);
		return;
	}
	throw new Error(`expected TaskGateError with code ${code}`);
}

describe("task gate store", () => {
	it("request creates a pending gate and persists the full safe transition", () => {
		const session = makeSession();
		const store = makeStore(session);

		const result = store.request(request({ runId: "run_abc123" }));

		expect(result).toEqual({
			gate: {
				schemaVersion: 1,
				sessionId: session.getSessionId(),
				gateId: "gate_001",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
				runId: "run_abc123",
			},
			appended: true,
			idempotent: false,
			entryId: expect.any(String),
		});
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0]).toMatchObject({
			type: "custom",
			customType: TASK_GATE_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				action: "requested",
				gate: {
					schemaVersion: 1,
					sessionId: session.getSessionId(),
					gateId: "gate_001",
					taskId: "task_42",
					stageId: "stage_review",
					stageRevision: 3,
					status: "pending",
					revision: 0,
					requestedAt: NOW,
					runId: "run_abc123",
				},
				previousRevision: 0,
				clientRequestId: "req-1",
			},
		});
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("task_42");
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("stage_review");
	});

	it("rejects a second gate for the same business key without appending", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());

		expectGateError(() => store.request(request({ clientRequestId: "req-2" })), "task_gate_conflict");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("creates a new gate for a higher stageRevision", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		const next = store.request(request({ stageRevision: 4, clientRequestId: "req-2" }));

		expect(next.gate.gateId).toBe("gate_002");
		expect(next.gate.stageRevision).toBe(4);
		expect(store.list().gates).toHaveLength(2);
	});

	it("rejects invalid request input without writing anything", () => {
		const session = makeSession();
		const store = makeStore(session);

		for (const stageRevision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectGateError(() => store.request(request({ stageRevision })), "task_gate_invalid");
		}
		for (const taskId of ["", "a/b", "http://host/x", "a b", "x".repeat(300), "a@b"]) {
			expectGateError(() => store.request(request({ taskId })), "task_gate_invalid");
		}
		for (const runId of ["", "../escape", "x?y", "a\nb"]) {
			expectGateError(() => store.request(request({ runId })), "task_gate_invalid");
		}
		expectGateError(() => store.request(request({ clientRequestId: "" })), "task_gate_invalid");
		const withPrompt = { ...request(), prompt: "approve this" };
		expectGateError(() => store.request(withPrompt), "task_gate_invalid");
		expect(session.getEntries()).toHaveLength(0);
	});

	it("rejects invalid decision input without writing anything", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());

		expectGateError(() => store.approve(decide("gate_001", "app-1", { reasonCode: "nope" })), "task_gate_invalid");
		expectGateError(() => store.approve(decide("gate_001", "app-1", { actorId: "../bad" })), "task_gate_invalid");
		expectGateError(() => store.reject(decide("gate_001", "rej-1", { reasonCode: "a/b" })), "task_gate_invalid");
		expectGateError(() => store.cancel(decide("gate_001", "can-1", { reasonCode: "x".repeat(300) })), "task_gate_invalid");
		expectGateError(() => store.approve(decide("gate_001", "")), "task_gate_invalid");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("approve, reject, and cancel each move a pending gate to its terminal state", () => {
		const approved = makeSession();
		const approvedStore = makeStore(approved);
		approvedStore.request(request());
		const result = approvedStore.approve(decide("gate_001", "app-1", { actorId: "operator_7" }));

		expect(result.gate).toMatchObject({
			gateId: "gate_001",
			status: "approved",
			revision: 1,
			decidedAt: NOW,
			actorId: "operator_7",
		});
		expect(result.appended).toBe(true);
		expect(approved.getEntries()).toHaveLength(2);
		expect(approved.getEntries()[1]).toMatchObject({
			customType: TASK_GATE_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				action: "approved",
				previousRevision: 0,
				clientRequestId: "app-1",
				gate: {
					status: "approved",
					revision: 1,
					requestedAt: NOW,
					decidedAt: NOW,
					actorId: "operator_7",
				},
			},
		});

		const rejected = makeSession();
		const rejectedStore = makeStore(rejected);
		rejectedStore.request(request());
		const rejectResult = rejectedStore.reject(decide("gate_001", "rej-1", { actorId: "operator_7", reasonCode: "quality_check_failed" }));
		expect(rejectResult.gate).toMatchObject({ status: "rejected", revision: 1, reasonCode: "quality_check_failed" });

		const cancelled = makeSession();
		const cancelledStore = makeStore(cancelled);
		cancelledStore.request(request());
		const cancelResult = cancelledStore.cancel(decide("gate_001", "can-1"));
		expect(cancelResult.gate).toMatchObject({ status: "cancelled", revision: 1, decidedAt: NOW });
		expect(cancelResult.gate.actorId).toBeUndefined();
		expect(cancelResult.gate.reasonCode).toBeUndefined();
	});

	it("replays an identical request idempotently without appending a second transition", () => {
		const session = makeSession();
		const store = makeStore(session);
		const first = store.request(request());
		const second = store.request(request());

		expect(second).toEqual({ gate: first.gate, appended: false, idempotent: true });
		expect(session.getEntries()).toHaveLength(1);
	});

	it("replays an identical decision idempotently without appending a second transition", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		const first = store.approve(decide("gate_001", "app-1", { actorId: "operator_7" }));
		const second = store.approve(decide("gate_001", "app-1", { actorId: "operator_7" }));

		expect(second).toEqual({ gate: first.gate, appended: false, idempotent: true });
		expect(session.getEntries()).toHaveLength(2);
	});

	it("rejects a reused clientRequestId with a different payload", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());

		expectGateError(() => store.request(request({ taskId: "task_43" })), "task_gate_idempotency_conflict");
		expectGateError(() => store.request(request({ stageRevision: 4 })), "task_gate_idempotency_conflict");
		expect(session.getEntries()).toHaveLength(1);

		store.approve(decide("gate_001", "app-1", { actorId: "operator_7" }));
		expectGateError(() => store.approve(decide("gate_001", "app-1", { actorId: "other_operator" })), "task_gate_idempotency_conflict");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("scopes idempotency per command type", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request({ clientRequestId: "shared-key" }));
		const decision = store.approve(decide("gate_001", "shared-key"));

		expect(decision.appended).toBe(true);
		expect(decision.gate.status).toBe("approved");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("settles concurrent opposite decisions with first terminal writer wins", () => {
		const session = makeSession();
		const firstWriter = makeStore(session);
		const secondWriter = makeStore(session);
		firstWriter.request(request());

		const approve = firstWriter.approve(decide("gate_001", "app-1"));
		expect(approve.gate.status).toBe("approved");

		expectGateError(() => secondWriter.reject(decide("gate_001", "rej-1")), "task_gate_conflict");
		expect(secondWriter.get("gate_001")?.status).toBe("approved");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("does not append a second transition for a repeated same decision with a new key", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		store.approve(decide("gate_001", "app-1"));

		expectGateError(() => store.approve(decide("gate_001", "app-2")), "task_gate_not_pending");
		expect(store.get("gate_001")?.status).toBe("approved");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("never overwrites a terminal gate with the opposite decision", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		store.cancel(decide("gate_001", "can-1"));

		expectGateError(() => store.approve(decide("gate_001", "app-1")), "task_gate_conflict");
		expectGateError(() => store.reject(decide("gate_001", "rej-1")), "task_gate_conflict");
		expect(store.get("gate_001")?.status).toBe("cancelled");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("returns not_found for unknown gates and invalid for unsafe gate ids", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());

		expect(store.get("gate_missing")).toBeUndefined();
		expectGateError(() => store.approve(decide("gate_missing", "app-1")), "task_gate_not_found");
		expectGateError(() => store.reject(decide("gate_missing", "rej-1")), "task_gate_not_found");
		expectGateError(() => store.get("../escape"), "task_gate_invalid");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("recovers pending and terminal gates after a session reload from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "task-gate-reload-"));
		try {
			const first = SessionManager.create(dir, dir);
			first.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			first.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "seed reply" }],
				api: "anthropic-messages",
				provider: "test",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp: 2,
			});
			const pendingStore = makeStore(first);
			pendingStore.request(request());
			const sessionFile = first.getSessionFile();
			if (!sessionFile) throw new Error("expected a persisted session file");

			const reloaded = SessionManager.open(sessionFile, dir);
			const restored = new TaskGateStore(reloaded, { now: () => NOW, createGateId: () => "gate_001" });
			expect(restored.get("gate_001")).toMatchObject({ status: "pending", revision: 0, taskId: "task_42" });

			const terminalStore = makeStore(reloaded);
			const decision = terminalStore.approve(decide("gate_001", "app-1", { actorId: "operator_7" }));
			expect(decision.gate.status).toBe("approved");

			const reopened = SessionManager.open(sessionFile, dir);
			const terminalRestored = new TaskGateStore(reopened, { now: () => NOW, createGateId: () => "gate_001" });
			expect(terminalRestored.get("gate_001")).toMatchObject({
				status: "approved",
				revision: 1,
				decidedAt: NOW,
				actorId: "operator_7",
			});
			expect(terminalRestored.warnings()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips malformed, unsupported, mismatched, gapped, and illegal entries without exposing raw data", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request({ clientRequestId: "req-1" }));
		const sessionId = session.getSessionId();

		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, { schemaVersion: 2, action: "requested" });
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, "raw garbage");
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId: "other-session",
				gateId: "gate_other",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-other",
		});
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "approved",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_gap",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "approved",
				revision: 1,
				requestedAt: NOW,
				decidedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-gap",
		});
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_dup",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 5,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-dup",
		});
		const illegalTransitionId = session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_dup",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 5,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-dup-2",
		});
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "rejected",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_dup",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 5,
				status: "rejected",
				revision: 1,
				requestedAt: NOW,
				decidedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-dup-t1",
		});
		const secondTerminalId = session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "approved",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_dup",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 5,
				status: "approved",
				revision: 1,
				requestedAt: NOW,
				decidedAt: NOW,
			},
			previousRevision: 1,
			clientRequestId: "req-dup-t2",
		});
		const idempotencyConflictId = session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_samekey",
				taskId: "task_99",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-1",
		});
		const businessConflictId = session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_otherkey",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-key-conflict",
		});

		const restarted = new TaskGateStore(session, { now: () => NOW, createGateId: () => "gate_001" });

		expect(restarted.get("gate_001")).toMatchObject({ status: "pending", gateId: "gate_001" });
		expect(restarted.get("gate_other")).toBeUndefined();
		expect(restarted.get("gate_gap")).toBeUndefined();
		expect(restarted.get("gate_samekey")).toBeUndefined();
		expect(restarted.get("gate_otherkey")).toBeUndefined();
		// gate_dup's first request and first terminal are legal; the duplicate
		// request and the second terminal are skipped.
		expect(restarted.get("gate_dup")).toMatchObject({ status: "rejected", revision: 1 });
		expect(restarted.list().gates.map((gate) => gate.gateId)).toEqual(["gate_001", "gate_dup"]);
		expect(restarted.warnings().map((warning) => warning.code)).toEqual([
			"unsupported_schema",
			"malformed_source",
			"session_mismatch",
			"revision_gap",
			"illegal_transition",
			"illegal_transition",
			"idempotency_conflict",
			"business_key_conflict",
		]);
		expect(restarted.warnings().map((warning) => warning.entryId)).toEqual([
			expect.any(String),
			expect.any(String),
			expect.any(String),
			expect.any(String),
			illegalTransitionId,
			secondTerminalId,
			idempotencyConflictId,
			businessConflictId,
		]);
		expect(JSON.stringify(restarted.warnings())).not.toContain("raw garbage");
		expect(JSON.stringify(restarted.warnings())).not.toContain("other-session");
	});

	it("folds duplicate identical idempotent entries into a single result without warnings", () => {
		const session = makeSession();
		const sessionId = session.getSessionId();
		const transition = {
			schemaVersion: 1,
			action: "requested",
			gate: {
				schemaVersion: 1,
				sessionId,
				gateId: "gate_001",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				requestedAt: NOW,
			},
			previousRevision: 0,
			clientRequestId: "req-1",
		};
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, transition);
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, transition);

		const folded = foldTaskGateEntries(session.getEntries(), sessionId);

		expect(folded.gates).toHaveLength(1);
		expect(folded.warnings).toEqual([]);
	});

	it("reports append failures as persistence errors without acknowledging success", () => {
		const inner = makeSession();
		const session = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => {
				throw new Error("disk full");
			},
		};
		const store = new TaskGateStore(session, { now: () => NOW, createGateId: () => "gate_001" });

		expectGateError(() => store.request(request()), "task_gate_persistence_failed");
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("does not acknowledge an append that is not visible in durable entries", () => {
		const inner = makeSession();
		const session = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => "entry-not-visible",
		};
		const store = new TaskGateStore(session, { now: () => NOW, createGateId: () => "gate_001" });

		expectGateError(() => store.request(request()), "task_gate_persistence_failed");
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("fails without writing when the timestamp source fails", () => {
		const session = makeSession();
		const store = new TaskGateStore(session, {
			now: () => {
				throw new Error("clock broken");
			},
			createGateId: () => "gate_001",
		});

		expectGateError(() => store.request(request()), "task_gate_persistence_failed");
		expect(session.getEntries()).toHaveLength(0);
	});

	it("keeps get and list read-only and applies filters and bounded limits", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		store.approve(decide("gate_001", "app-1"));
		store.request(request({ stageId: "stage_impl", stageRevision: 1, clientRequestId: "req-2" }));
		store.request(request({ taskId: "task_7", stageId: "stage_review", stageRevision: 1, clientRequestId: "req-3" }));
		const entriesBefore = session.getEntries().length;

		expect(store.get("gate_001")?.status).toBe("approved");
		expect(store.list().gates).toHaveLength(3);
		expect(store.list({ status: "pending" }).gates.map((gate) => gate.gateId)).toEqual(["gate_002", "gate_003"]);
		expect(store.list({ taskId: "task_42", stageId: "stage_review" }).gates.map((gate) => gate.gateId)).toEqual(["gate_001"]);
		expect(store.list({ taskId: "task_missing" }).gates).toEqual([]);
		const truncated = store.list({ limit: 2 });
		expect(truncated.gates).toHaveLength(2);
		expect(truncated.truncated).toBe(true);
		expect(store.list({ limit: 100 }).truncated).toBe(false);
		expectGateError(() => store.list({ limit: 101 }), "task_gate_invalid");
		expectGateError(() => store.list({ limit: 0 }), "task_gate_invalid");
		expectGateError(() => store.list({ status: "running" as TaskGateStatus }), "task_gate_invalid");
		expect(session.getEntries()).toHaveLength(entriesBefore);
	});

	it("returns defensive copies that cannot mutate store state", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		const gate = store.get("gate_001");
		if (gate === undefined) throw new Error("expected gate");

		(gate as { status: string }).status = "approved";
		(gate as { revision: number }).revision = 99;
		expect(store.get("gate_001")).toMatchObject({ status: "pending", revision: 0 });
	});

	it("emits diagnostics once per malformed entry", () => {
		const session = makeSession();
		session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, "raw garbage");
		const codes: string[] = [];
		const store = new TaskGateStore(session, { now: () => NOW, createGateId: () => "gate_001", diagnostics: (warning) => codes.push(warning.code) });

		store.refresh();

		expect(codes).toEqual(["malformed_source"]);
	});

	it("exposes stable action and command mappings", () => {
		expect(taskGateCommandType("requested")).toBe("task.gate.request");
		expect(taskGateCommandType("approved")).toBe("task.gate.approve");
		expect(taskGateCommandType("rejected")).toBe("task.gate.reject");
		expect(taskGateCommandType("cancelled")).toBe("task.gate.cancel");
		expect(taskGateActionForStatus("pending")).toBe("requested");
		expect(taskGateActionForStatus("approved")).toBe("approved");
		expect(taskGateActionForStatus("rejected")).toBe("rejected");
		expect(taskGateActionForStatus("cancelled")).toBe("cancelled");
	});

	it("validates records and transitions without accepting forbidden fields", () => {
		expect(isTaskGateRecord({ schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 1, status: "pending", revision: 0, requestedAt: NOW })).toBe(true);
		expect(isTaskGateRecord({ schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 1, status: "pending", revision: 0, requestedAt: NOW, decidedAt: NOW })).toBe(false);
		expect(isTaskGateRecord({ schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 1, status: "approved", revision: 1, requestedAt: NOW, decidedAt: NOW, prompt: "approve" })).toBe(false);
		expect(isTaskGateRecord({ schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 0, status: "pending", revision: 0, requestedAt: NOW })).toBe(false);
		expect(isTaskGateRecord({ schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 1, status: "pending", revision: 0, requestedAt: "not-a-timestamp" })).toBe(false);

		const transition = {
			schemaVersion: 1,
			action: "approved",
			gate: { schemaVersion: 1, sessionId: "s", gateId: "g", taskId: "t", stageId: "st", stageRevision: 1, status: "approved", revision: 1, requestedAt: NOW, decidedAt: NOW },
			previousRevision: 0,
			clientRequestId: "req-1",
		};
		expect(isTaskGateTransition(transition)).toBe(true);
		expect(isTaskGateTransition({ ...transition, action: "requested" })).toBe(false);
		expect(isTaskGateTransition({ ...transition, clientRequestId: "" })).toBe(false);
		expect(isTaskGateTransition({ ...transition, schemaVersion: 2 })).toBe(false);
	});

	it("keeps gate state independent from run and policy ledgers", () => {
		const session = makeSession();
		const store = makeStore(session);
		store.request(request());
		store.approve(decide("gate_001", "app-1"));

		expect(session.getEntries().every((entry) => entry.type === "custom" && entry.customType === TASK_GATE_CUSTOM_TYPE)).toBe(true);
		expect(session.getEntries()).toHaveLength(2);
	});
});
