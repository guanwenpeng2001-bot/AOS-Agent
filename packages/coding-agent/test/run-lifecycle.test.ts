import type { AssistantMessage } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	buildCapabilityCatalog,
	resolveCapabilityBinding,
	type CapabilityBinding,
} from "../src/core/capability-registry.ts";
import {
	CAPABILITY_BINDING_CUSTOM_TYPE,
	createAutomationError,
	createRunLifecycleCoordinator,
	foldCapabilityBindingEntries,
	isTerminalStatus,
	redactAutomationError,
	redactErrorText,
	RUN_LEDGER_CUSTOM_TYPE,
	type AutomationError,
	type CapabilityBindingLedgerRecord,
	type RunHandle,
	type RunLedgerSession,
	type RunLifecycleCoordinator,
	type RunModelReference,
	type RunReservation,
	type RunResult,
} from "../src/core/run-lifecycle.ts";
import {
	SessionManager,
	type SessionEntry,
	type SessionTreeNode,
} from "../src/core/session-manager.ts";

// agent-session.ts / session-manager.ts transitively load @aos-agent/ai/compat,
// whose entrypoint pulls in gitignored generated model catalogs absent under
// `npm ci --ignore-scripts`. Mock only the symbols the exercised paths touch;
// compaction-only helpers are stubs.
vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => {
		throw new Error("streamSimple is not exercised by this harness");
	},
}));

// loader.ts holds @aos-agent/ai/providers/all only as a virtual-module namespace
// for bundling; an empty mock avoids loading its generated catalog.
vi.mock("@aos-agent/ai/providers/all", () => ({}));

const MODEL: RunModelReference = { provider: "anthropic", id: "claude-sonnet-5", thinkingLevel: "high" };

/** Metadata-only redacted binding used by capability-related coordinator tests. */
const BINDING: CapabilityBindingLedgerRecord = {
	id: "binding:default:abc123",
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [{ id: "builtin_tool:core:read", revision: "rev:1", exposedToolName: "Read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read"],
};

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/automation");
}

function makeCoordinator(
	session?: SessionManager,
	now?: () => string,
	diagnostics?: (message: string) => void,
): RunLifecycleCoordinator {
	return createRunLifecycleCoordinator(session ?? makeSession(), { now, diagnostics: diagnostics ?? (() => {}) });
}

function accept(reservation: RunReservation, runId?: string, attempt = 1): RunHandle {
	return reservation.accept({ runId, attempt, model: MODEL });
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function messageEnd(message: AssistantMessage): AgentSessionEvent {
	return { type: "message_end", message };
}

function agentEnd(messages: AssistantMessage[]): AgentSessionEvent {
	return { type: "agent_end", messages, willRetry: false };
}

function settled(): AgentSessionEvent {
	return { type: "agent_settled" };
}

function isAutomationRunEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE;
}

function ledgerKinds(session: SessionManager): string[] {
	return session
		.getEntries()
		.filter(isAutomationRunEntry)
		.map((entry) => (entry.data as { kind?: string }).kind ?? "(missing)");
}

function flattenTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	const stack = [...nodes];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) continue;
		out.push(node);
		stack.push(...node.children);
	}
	return out;
}

/** A real in-memory session whose ledger append fails after `after` successful calls. */
function failingSession(after: number): RunLedgerSession {
	const inner = makeSession();
	let calls = 0;
	return {
		getSessionId: () => inner.getSessionId(),
		getSessionFile: () => inner.getSessionFile(),
		appendCustomEntry: (customType: string, data?: unknown) => {
			calls += 1;
			if (calls > after) throw new Error("disk full");
			return inner.appendCustomEntry(customType, data);
		},
		getEntries: () => inner.getEntries(),
	};
}

describe("state machine", () => {
	it("moves accepted -> running -> completed and never exposes a pending state", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const reservation = coordinator.reserve();
		const run = accept(reservation, "r1");

		expect(run.record.status).toBe("accepted");
		expect(run.record.attempt).toBe(1);
		expect(run.record.model).toEqual(MODEL);
		expect(run.record.startedAt).toBeUndefined();
		expect(run.sequence).toBe(0);
		expect(coordinator.activeRun?.record.status).toBe("accepted");

		const started = run.start();
		expect(started.map((event) => event.type)).toEqual(["run.started"]);
		expect(run.record.status).toBe("running");
		expect(run.record.startedAt).toBeDefined();
		expect(started[0]).toMatchObject({ type: "run.started", runId: "r1", sessionId: session.getSessionId(), sequence: 1 });

		const terminal = run.settle({ outcome: "completed" });
		expect(terminal?.type).toBe("run.completed");
		expect(run.record.status).toBe("completed");
		expect(run.record.endedAt).toBeDefined();
		expect(run.receipt()).toMatchObject({ runId: "r1", sessionId: session.getSessionId(), status: "completed" });
		expect(isTerminalStatus(run.record.status)).toBe(true);
		expect(isTerminalStatus("accepted")).toBe(false);
		expect(isTerminalStatus("running")).toBe(false);
		expect(coordinator.activeRun).toBeUndefined();
	});

	it("records cancellation intent; cancelled beats completed and failed at settle", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.requestCancel();
		expect(run.cancelled).toBe(true);
		run.start();
		const terminal = run.settle({ outcome: "completed" });
		expect(terminal).toMatchObject({ type: "run.cancelled", receipt: { status: "cancelled" } });
		expect(run.receipt()?.status).toBe("cancelled");
	});

	it("settles a failed run with a structured terminal error", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = run.settle({
			outcome: "failed",
			terminalError: createAutomationError("host_not_initialized", "boom", false),
		});
		expect(terminal?.type).toBe("run.failed");
		expect(run.receipt()?.terminalError).toEqual({ code: "host_not_initialized", message: "boom", retryable: false });
		expect(run.record.terminalError?.code).toBe("host_not_initialized");
	});

	it("records the source run id and attempt for a resumed run", () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		const run = reservation.accept({ runId: "r2", sourceRunId: "r1", attempt: 2, model: MODEL });
		expect(run.record.sourceRunId).toBe("r1");
		expect(run.record.attempt).toBe(2);
	});
});

describe("model_error terminal code", () => {
	it("appears on the run.failed receipt and terminal event", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = run.settle({
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});
		expect(terminal?.type).toBe("run.failed");
		expect(terminal).toMatchObject({
			receipt: { status: "failed", terminalError: { code: "model_error", message: "529 overloaded_error: Overloaded" } },
		});
		expect(run.receipt()?.terminalError).toEqual({
			code: "model_error",
			message: "529 overloaded_error: Overloaded",
			retryable: false,
		});
		expect(run.record.status).toBe("failed");
		expect(run.record.terminalError?.code).toBe("model_error");
	});

	it("persists a model_error terminal fact in the ledger", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});
		const terminalEntry = session
			.getEntries()
			.filter(isAutomationRunEntry)
			.find((entry) => (entry.data as { kind?: string }).kind === "terminal");
		const persisted = (terminalEntry?.data as { receipt?: { terminalError?: AutomationError } }).receipt?.terminalError;
		expect(persisted).toEqual({
			code: "model_error",
			message: "529 overloaded_error: Overloaded",
			retryable: false,
		});
	});

	it("replays a model_error failed receipt from the ledger", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.settle({
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result?.record.status).toBe("failed");
		expect(result?.receipt?.terminalError).toEqual({
			code: "model_error",
			message: "529 overloaded_error: Overloaded",
			retryable: false,
		});
		expect(result?.record.terminalError?.code).toBe("model_error");
		expect(result?.recovery).toBeUndefined();
	});

	it("validates a hand-written model_error terminal fact during runtime parsing", () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: { id: "r-model", sessionId: session.getSessionId(), attempt: 1, status: "failed", model: MODEL },
		});
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: "2026-08-10T12:00:04.000Z",
			receipt: {
				runId: "r-model",
				sessionId: session.getSessionId(),
				status: "failed",
				usage: { input: 800, output: 200, total: 1000 },
				terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
			},
		});

		const coordinator = makeCoordinator(session);
		const result = coordinator.rebuildIndex().get("r-model");
		expect(result).toBeDefined();
		expect(result?.record.status).toBe("failed");
		expect(result?.receipt?.terminalError).toEqual({
			code: "model_error",
			message: "529 overloaded_error: Overloaded",
			retryable: false,
		});
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(false);
	});
});

describe("duplicate terminal / late events / cancellation", () => {
	it("ignores a second terminal, records a duplicate-terminal diagnostic, and persists one terminal fact", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const first = run.settle({ outcome: "completed" });
		expect(first?.type).toBe("run.completed");

		const second = run.settle({
			outcome: "failed",
			terminalError: createAutomationError("host_not_initialized", "late", false),
		});
		expect(second).toBeUndefined();
		expect(run.receipt()?.status).toBe("completed");
		expect(coordinator.diagnostics().some((diag) => diag.kind === "duplicate-terminal")).toBe(true);
		expect(ledgerKinds(session).filter((kind) => kind === "terminal")).toHaveLength(1);
	});

	it("ignores a late cancel after the run is already terminal", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });
		run.requestCancel();
		expect(run.receipt()?.status).toBe("completed");
		expect(run.terminal?.type).toBe("run.completed");
	});

	it("drops session events captured after the run is terminal", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });
		const before = run.emitted.length;
		expect(run.captureSessionEvent(agentEnd([assistantMessage("late")]))).toBeUndefined();
		expect(run.emitted.length).toBe(before);
		expect(run.emitted.every((event) => event.type !== "run.event")).toBe(true);
	});
});

describe("per-session reservation", () => {
	it("rejects a second concurrent reservation with a retryable session_busy error", () => {
		const coordinator = makeCoordinator();
		coordinator.reserve();
		let error: AutomationError | undefined;
		try {
			coordinator.reserve();
		} catch (caught) {
			error = caught as AutomationError;
		}
		expect(error?.code).toBe("session_busy");
		expect(error?.retryable).toBe(true);
	});

	it("frees the session when a reservation is released without accepting", () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		reservation.release();
		expect(coordinator.getActiveRun()).toBeUndefined();
		expect(() => coordinator.reserve()).not.toThrow();
	});

	it("frees the session once the run is terminal and a new run can be reserved", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });
		expect(coordinator.getActiveRun()).toBeUndefined();
		const next = accept(coordinator.reserve(), "r2");
		expect(next.runId).toBe("r2");
		expect(next.record.status).toBe("accepted");
	});

	it("rejects re-accepting a consumed reservation", () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		accept(reservation, "r1");
		expect(() => reservation.accept({ runId: "r2", attempt: 1, model: MODEL })).toThrow();
	});

	it("auto-generates distinct run ids across separate coordinators", () => {
		const c1 = makeCoordinator();
		const c2 = makeCoordinator();
		const a = accept(c1.reserve());
		const b = accept(c2.reserve());
		expect(a.runId).not.toBe(b.runId);
		expect(a.runId).not.toBe("");
		expect(b.runId).not.toBe("");
	});
});

describe("event buffering and sequence", () => {
	it("buffers pre-start events and flushes them after the sequence-1 started event", () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		reservation.captureSessionEvent(agentEnd([assistantMessage("a")]));
		reservation.captureSessionEvent(settled());
		const run = reservation.accept({ runId: "r1", attempt: 1, model: MODEL });
		// Accepted-state capture stays buffered and returns no event.
		expect(run.captureSessionEvent(agentEnd([assistantMessage("b")]))).toBeUndefined();

		const events = run.start();
		expect(events.map((event) => event.type)).toEqual(["run.started", "run.event", "run.event", "run.event"]);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
		expect(events[0]).toMatchObject({ type: "run.started", runId: "r1" });
		expect((events[1] as Extract<typeof events[number], { type: "run.event" }>).event.type).toBe("agent_end");

		const terminal = run.settle({ outcome: "completed" });
		expect(terminal?.sequence).toBe(5);
		expect(run.emitted.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
	});

	it("returns exactly one wrapped run.event per captured session event while running", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const wrapped = run.captureSessionEvent(settled());
		expect(wrapped).toMatchObject({ type: "run.event", runId: "r1", sequence: 2 });
		if (wrapped === undefined || wrapped.type !== "run.event") throw new Error("expected run.event");
		expect(wrapped.event).toEqual({ type: "agent_settled" });
		expect(wrapped.timestamp).toBeDefined();
		expect(run.emitted.filter((event) => event.type === "run.event")).toHaveLength(1);
	});

	it("wraps events captured after start without reordering the stream", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		expect(run.captureSessionEvent(settled())).toMatchObject({ type: "run.event", sequence: 2 });
		expect(run.captureSessionEvent(agentEnd([assistantMessage("done")]))).toMatchObject({
			type: "run.event",
			sequence: 3,
		});
		expect(run.emitted.map((event) => event.type)).toEqual(["run.started", "run.event", "run.event"]);
	});

	it("captures the final assistant text from message_end and agent_end", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.captureSessionEvent(messageEnd(assistantMessage("hello ")));
		run.captureSessionEvent(messageEnd(assistantMessage("world")));
		run.captureSessionEvent(agentEnd([assistantMessage("earlier"), assistantMessage("final answer")]));
		expect(run.finalText()).toBe("final answer");
		run.start();
		run.settle({ outcome: "completed" });
		expect(run.receipt()?.finalText).toBe("final answer");
	});
});

describe("usage deltas", () => {
	it("computes non-negative usage deltas against the baseline", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.setUsageBaseline({ input: 100, output: 20, total: 120 });
		expect(run.computeUsageDelta({ input: 150, output: 25, total: 180 })).toEqual({ input: 50, output: 5, total: 60 });
		expect(run.computeUsageDelta({ input: 80, output: 10, total: 100 })).toEqual({ input: 0, output: 0, total: 0 });
	});

	it("writes the usage delta into the terminal receipt", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.setUsageBaseline({ input: 10, output: 5, total: 15 });
		run.start();
		run.settle({ outcome: "completed", currentUsage: { input: 40, output: 15, total: 60 } });
		expect(run.receipt()?.usage).toEqual({ input: 30, output: 10, total: 45 });
	});
});

describe("ledger persistence and context isolation", () => {
	it("persists accepted/started/terminal automation.run custom entries", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });
		expect(ledgerKinds(session)).toEqual(["accepted", "started", "terminal"]);
	});

	it("keeps custom entries out of the model context while preserving entries and tree", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });

		const context = session.buildSessionContext();
		expect(context.messages).toEqual([]);

		session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
		const context2 = session.buildSessionContext();
		expect(context2.messages).toHaveLength(1);
		expect(context2.messages[0].role).toBe("user");

		const entries: SessionEntry[] = session.getEntries();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE)).toBe(true);

		const tree = session.getTree();
		const flat = flattenTree(tree);
		expect(flat.some((node) => node.entry.type === "custom" && node.entry.customType === RUN_LEDGER_CUSTOM_TYPE)).toBe(true);
	});
});

describe("persistence failures", () => {
	it("surfaces a ledger persistence failure at start without emitting events", () => {
		const coordinator = createRunLifecycleCoordinator(failingSession(1), { diagnostics: () => {} });
		const run = accept(coordinator.reserve(), "r1");
		let error: AutomationError | undefined;
		try {
			run.start();
		} catch (caught) {
			error = caught as AutomationError;
		}
		expect(error?.code).toBe("ledger_persistence_failed");
		expect(error?.retryable).toBe(false);
		expect(run.record.status).toBe("accepted");
		expect(run.sequence).toBe(0);
	});

	it("surfaces a ledger persistence failure at settle without a terminal", () => {
		const coordinator = createRunLifecycleCoordinator(failingSession(2), { diagnostics: () => {} });
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		let error: AutomationError | undefined;
		try {
			run.settle({ outcome: "completed" });
		} catch (caught) {
			error = caught as AutomationError;
		}
		expect(error?.code).toBe("ledger_persistence_failed");
		expect(run.receipt()).toBeUndefined();
		expect(run.record.status).toBe("running");
	});

	it("consumes and releases the reservation when persisting the accepted fact fails", () => {
		const coordinator = createRunLifecycleCoordinator(failingSession(0), { diagnostics: () => {} });
		const reservation = coordinator.reserve();
		let error: AutomationError | undefined;
		try {
			reservation.accept({ runId: "r1", attempt: 1, model: MODEL });
		} catch (caught) {
			error = caught as AutomationError;
		}
		expect(error?.code).toBe("ledger_persistence_failed");
		// The failed accept consumed the reservation...
		expect(() => reservation.accept({ runId: "r1", attempt: 1, model: MODEL })).toThrow();
		// ...and released the session lock: a fresh reserve succeeds and reaches persistence (not session_busy).
		const nextReservation = coordinator.reserve();
		let nextError: AutomationError | undefined;
		try {
			nextReservation.accept({ runId: "r2", attempt: 1, model: MODEL });
		} catch (caught) {
			nextError = caught as AutomationError;
		}
		expect(nextError?.code).toBe("ledger_persistence_failed");
	});
});

describe("ledger replay and corruption", () => {
	it("rebuilds a completed run with receipt from the SessionManager custom entries", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.captureSessionEvent(agentEnd([assistantMessage("final")]));
		run.start();
		run.settle({ outcome: "completed", currentUsage: { input: 30, output: 5, total: 35 } });

		const c2 = makeCoordinator(session);
		const index = c2.rebuildIndex();
		const result = index.get("r1");
		expect(result).toBeDefined();
		expect(result?.record.status).toBe("completed");
		expect(result?.record.attempt).toBe(1);
		expect(result?.record.startedAt).toBeDefined();
		expect(result?.record.endedAt).toBeDefined();
		expect(result?.receipt?.status).toBe("completed");
		expect(result?.receipt?.finalText).toBe("final");
		expect(result?.receipt?.usage).toEqual({ input: 30, output: 5, total: 35 });
		expect(result?.recovery).toBeUndefined();
		expect(c2.getRun("r1")).toEqual(result);
	});

	it("skips malformed, unknown-version, unknown-kind and orphan entries without breaking recovery", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });

		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, { schemaVersion: 1, kind: "bogus" });
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 999,
			kind: "accepted",
			record: { id: "x" },
		});
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, "not an object");
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "started",
			runId: "ghost",
			startedAt: "2026-08-10T00:00:00.000Z",
		});

		const c2 = makeCoordinator(session);
		const index = c2.rebuildIndex();
		expect(index.get("r1")?.record.status).toBe("completed");

		const diags = c2.diagnostics();
		expect(diags.some((diag) => diag.kind === "unknown-ledger-kind")).toBe(true);
		expect(diags.some((diag) => diag.kind === "unknown-schema-version")).toBe(true);
		expect(diags.some((diag) => diag.kind === "malformed")).toBe(true);
		expect(diags.some((diag) => diag.kind === "orphan-fact")).toBe(true);
	});

	it("delivers replay diagnostics to the diagnostics sink", () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, "garbage");
		const sink: string[] = [];
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: (message) => sink.push(message) });
		coordinator.rebuildIndex();
		expect(sink.some((message) => message.includes("malformed"))).toBe(true);
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(true);
	});

	it("does not mutate the persisted accepted record when replay applies later facts", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });

		const acceptedFact = (): Extract<SessionEntry, { type: "custom" }> => {
			const entry = session
				.getEntries()
				.filter(isAutomationRunEntry)
				.find((candidate) => (candidate.data as { kind?: string }).kind === "accepted");
			if (entry === undefined) throw new Error("expected an accepted ledger entry");
			return entry;
		};
		expect((acceptedFact().data as { record?: { status?: string } }).record?.status).toBe("accepted");

		makeCoordinator(session).rebuildIndex();

		expect((acceptedFact().data as { record?: { status?: string } }).record?.status).toBe("accepted");
		expect((acceptedFact().data as { record?: { endedAt?: string } }).record?.endedAt).toBeUndefined();
	});

	it("keeps the first receipt when replay sees duplicate terminal facts", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });

		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: "2026-08-10T01:00:00.000Z",
			receipt: {
				runId: "r1",
				sessionId: session.getSessionId(),
				status: "failed",
				usage: { input: 0, output: 0, total: 0 },
				terminalError: createAutomationError("host_not_initialized", "later", false),
			},
		});

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result?.receipt?.status).toBe("completed");
		expect(result?.receipt?.terminalError).toBeUndefined();
		expect(result?.record.status).toBe("completed");
		expect(c2.diagnostics().some((diag) => diag.kind === "duplicate-terminal")).toBe(true);
	});

	it("skips schema-1 malformed accepted and terminal facts without crashing", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });

		// schemaVersion 1 but the accepted record is incomplete (no model/status/attempt/sessionId).
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: { id: "broken-accepted" },
		});
		// schemaVersion 1 but the terminal receipt is incomplete (no usage numbers).
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: "2026-08-10T02:00:00.000Z",
			receipt: { runId: "broken-terminal", sessionId: session.getSessionId(), status: "completed" },
		});

		const c2 = makeCoordinator(session);
		let index: ReadonlyMap<string, RunResult> | undefined;
		expect(() => {
			index = c2.rebuildIndex();
		}).not.toThrow();

		expect(index?.get("r1")?.record.status).toBe("completed");
		expect(index?.get("broken-accepted")).toBeUndefined();
		expect(index?.get("broken-terminal")).toBeUndefined();
		expect(c2.diagnostics().filter((diag) => diag.kind === "malformed").length).toBeGreaterThanOrEqual(2);
	});
});

describe("interrupted recovery", () => {
	it("recovers an interrupted run as non-terminal without fabricating a terminal fact", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		run.captureSessionEvent(messageEnd(assistantMessage("partial")));
		// Process exits before settle: only accepted + started facts were persisted.

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result).toBeDefined();
		expect(result?.record.status).toBe("running");
		expect(result?.record.endedAt).toBeUndefined();
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");

		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
		expect(c2.getActiveRun()).toBeUndefined();
	});

	it("flags an accepted-but-never-started run as interrupted too", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		c1.reserve().accept({ runId: "r1", attempt: 1, model: MODEL });

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result?.record.status).toBe("accepted");
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");
	});

	it("returns a fresh live result from getRun after settle", () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		run.settle({ outcome: "completed" });
		expect(coordinator.getRun("r1")?.record.status).toBe("completed");
		expect(coordinator.getRun("missing")).toBeUndefined();
	});
});

describe("structural contract", () => {
	it("is satisfied by a real SessionManager without wrapping", () => {
		const session = makeSession();
		const ledgerSession: RunLedgerSession = session;
		const coordinator = createRunLifecycleCoordinator(ledgerSession);
		const reservation = coordinator.reserve();
		expect(reservation.sessionId).toBe(session.getSessionId());
		accept(reservation, "r1");
		expect(ledgerSession.getEntries().some(isAutomationRunEntry)).toBe(true);
	});
});

function isCapabilityBindingEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === CAPABILITY_BINDING_CUSTOM_TYPE;
}

describe("capability binding receipt and ledger", () => {
	it("records capabilityBindingId on the terminal receipt and persists a schemaVersion 1 entry", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "r1",
			attempt: 1,
			model: MODEL,
			capabilityBinding: BINDING,
		});
		run.start();
		const terminal = run.settle({ outcome: "completed" });
		expect(terminal?.type).toBe("run.completed");
		expect(run.receipt()?.capabilityBindingId).toBe(BINDING.id);

		const bindingEntries = session.getEntries().filter(isCapabilityBindingEntry);
		expect(bindingEntries).toHaveLength(1);
		const persisted = bindingEntries[0].data as { schemaVersion: number; binding: CapabilityBindingLedgerRecord };
		expect(persisted.schemaVersion).toBe(1);
		expect(persisted.binding).toEqual(BINDING);
	});

	it("replays capabilityBindingId and previousBindingId from the ledger after recovery", () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = c1.reserve().accept({
			runId: "r2",
			sourceRunId: "r1",
			previousBindingId: "binding:source:old",
			attempt: 2,
			model: MODEL,
			capabilityBinding: BINDING,
		});
		run.start();
		run.settle({ outcome: "completed" });

		const c2 = makeCoordinator(session);
		const result = c2.getRun("r2");
		expect(result?.record.sourceRunId).toBe("r1");
		expect(result?.record.previousBindingId).toBe("binding:source:old");
		expect(result?.receipt?.capabilityBindingId).toBe(BINDING.id);
		expect(c2.getCapabilityBindings().get(BINDING.id)).toEqual(BINDING);
	});

	it("records previousBindingId on the accepted record without a binding snapshot", () => {
		const coordinator = makeCoordinator();
		const run = coordinator.reserve().accept({
			runId: "r2",
			sourceRunId: "r1",
			previousBindingId: "binding:source:old",
			attempt: 2,
			model: MODEL,
		});
		expect(run.record.previousBindingId).toBe("binding:source:old");
	});
});

describe("capability binding ledger folding", () => {
	it("folds capability.binding custom entries into a redacted history", () => {
		const session = makeSession();
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 1, binding: BINDING });

		const folded = foldCapabilityBindingEntries(session.getEntries());
		expect(folded.get(BINDING.id)).toEqual(BINDING);

		const coordinator = makeCoordinator(session);
		expect(coordinator.getCapabilityBindings().get(BINDING.id)).toEqual(BINDING);
	});

	it("skips malformed capability.binding entries and reports malformed-binding diagnostics", () => {
		const session = makeSession();
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 1, binding: { id: "broken" } });
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 99, binding: BINDING });
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, "not an object");
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 1, binding: BINDING });

		const coordinator = makeCoordinator(session);
		coordinator.rebuildIndex();
		expect(coordinator.getCapabilityBindings().get(BINDING.id)).toEqual(BINDING);
		expect(coordinator.diagnostics().filter((diag) => diag.kind === "malformed-binding")).toHaveLength(3);
	});
});

const SELECTION_CATALOG = buildCapabilityCatalog({
	candidates: [
		{
			kind: "builtin_tool",
			name: "Read",
			sourceIdentity: "builtin",
			source: { path: "/test", source: "test-src", scope: "temporary", origin: "top-level" },
		},
		{
			kind: "builtin_tool",
			name: "Write",
			sourceIdentity: "builtin",
			source: { path: "/test", source: "test-src", scope: "temporary", origin: "top-level" },
		},
	],
});

/**
 * Resolve a binding with only the tool selection differing; the ledger record
 * carries no raw selection, so two bindings that differ only by selection
 * semantics are identical except for the id that encodes them.
 */
function selectionBinding(selection: {
	tools?: ReadonlyArray<string>;
	excludeTools?: ReadonlyArray<string>;
	noTools?: boolean;
}): CapabilityBinding {
	return resolveCapabilityBinding({
		catalog: SELECTION_CATALOG,
		profile: "default",
		profiles: { default: { rules: [] } },
		toolAllowlist: selection.tools,
		excludeToolNames: selection.excludeTools,
		noTools: selection.noTools,
		now: "2026-08-11T00:00:00.000Z",
	});
}

describe("capability binding selection-semantics ledger regression", () => {
	it("keeps tools vs excludeTools same-view bindings distinct through fold, rebuild, replay", () => {
		const viaTools = selectionBinding({ tools: ["Read"] });
		const viaExclude = selectionBinding({ excludeTools: ["Write"] });
		// tools and excludeTools converge on the same model-visible allowlist, so
		// the records differ only by the id that encodes the selection semantics.
		expect(viaTools.toolAllowlist).toEqual(["Read"]);
		expect(viaExclude.toolAllowlist).toEqual(["Read"]);
		expect({ ...viaExclude, id: viaTools.id }).toEqual(viaTools);
		expect(viaTools.id).not.toBe(viaExclude.id);

		const session = makeSession();
		const c1 = makeCoordinator(session);
		const viaToolsRun = c1.reserve().accept({
			runId: "r-tools",
			attempt: 1,
			model: MODEL,
			capabilityBinding: viaTools,
		});
		viaToolsRun.start();
		viaToolsRun.settle({ outcome: "completed" });
		const viaExcludeRun = c1.reserve().accept({
			runId: "r-exclude",
			attempt: 1,
			model: MODEL,
			capabilityBinding: viaExclude,
		});
		viaExcludeRun.start();
		viaExcludeRun.settle({ outcome: "completed" });

		// Ledger fold: neither record overwrites the other.
		const folded = foldCapabilityBindingEntries(session.getEntries());
		expect(folded.size).toBe(2);
		expect(folded.get(viaTools.id)).toEqual(viaTools);
		expect(folded.get(viaExclude.id)).toEqual(viaExclude);

		// Rebuild: both binding ids/views are recoverable and distinguishable.
		const c2 = makeCoordinator(session);
		const recovered = c2.getCapabilityBindings();
		expect(recovered.size).toBe(2);
		expect(recovered.get(viaTools.id)?.id).toBe(viaTools.id);
		expect(recovered.get(viaExclude.id)?.id).toBe(viaExclude.id);
		expect(recovered.get(viaTools.id)?.id).not.toBe(recovered.get(viaExclude.id)?.id);

		// Replay: each run keeps its intended binding id and resolves to its own record.
		const viaToolsResult = c2.getRun("r-tools");
		const viaExcludeResult = c2.getRun("r-exclude");
		expect(viaToolsResult?.receipt?.capabilityBindingId).toBe(viaTools.id);
		expect(viaExcludeResult?.receipt?.capabilityBindingId).toBe(viaExclude.id);
		expect(recovered.get(viaToolsResult?.receipt?.capabilityBindingId ?? "")).toEqual(viaTools);
		expect(recovered.get(viaExcludeResult?.receipt?.capabilityBindingId ?? "")).toEqual(viaExclude);
	});

	it("does not collapse a noTools binding with an empty tools binding after rebuild", () => {
		const viaNoTools = selectionBinding({ noTools: true });
		const viaEmptyTools = selectionBinding({ tools: [] });
		expect(viaNoTools.toolAllowlist).toEqual([]);
		expect(viaEmptyTools.toolAllowlist).toEqual([]);
		expect(viaNoTools.id).not.toBe(viaEmptyTools.id);

		const session = makeSession();
		const c1 = makeCoordinator(session);
		c1.persistCapabilityBinding(viaNoTools);
		c1.persistCapabilityBinding(viaEmptyTools);

		const recovered = makeCoordinator(session).getCapabilityBindings();
		expect(recovered.size).toBe(2);
		expect(recovered.get(viaNoTools.id)).toEqual(viaNoTools);
		expect(recovered.get(viaEmptyTools.id)).toEqual(viaEmptyTools);
		expect(recovered.get(viaNoTools.id)?.id).not.toBe(recovered.get(viaEmptyTools.id)?.id);
	});
});

describe("redacted error serialization", () => {
	it("redacts URL userinfo and well-known secret assignments from error text", () => {
		expect(redactErrorText("connect to https://user:secret@mcp.example.invalid/host failed")).toBe(
			"connect to https://mcp.example.invalid/host failed",
		);
		expect(redactErrorText("authorization: Bearer abc.def.ghi rejected")).toBe("authorization=[redacted] rejected");
		expect(redactErrorText("Bearer abc.def.ghi rejected")).toBe("[redacted] rejected");
		expect(redactErrorText("api_key=hunter2 is invalid")).toBe("api_key=[redacted] is invalid");
		expect(redactErrorText("token=xyz failed")).toBe("token=[redacted] failed");
		expect(redactErrorText("ordinary failure message")).toBe("ordinary failure message");
	});

	it("never leaves a secret payload visible after redaction", () => {
		const redacted = redactErrorText(
			"auth https://user:pass@mcp.example.invalid authorization: Bearer abc.def.ghi api_key=hunter2 token=xyz password=sesame",
		);
		expect(redacted).not.toMatch(/abc\.def\.ghi|hunter2|xyz|sesame|user:pass/);
	});

	it("redacts an AutomationError message while preserving code and retryable", () => {
		const error = createAutomationError("capability_mcp_connect_failed", "token=xyz failed", true);
		const redacted = redactAutomationError(error);
		expect(redacted.code).toBe("capability_mcp_connect_failed");
		expect(redacted.retryable).toBe(true);
		expect(redacted.message).toBe("token=[redacted] failed");
	});
});

describe("terminal error redaction", () => {
	it("redacts a terminalError before persistence, emission and the retained record", () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = run.settle({
			outcome: "failed",
			terminalError: createAutomationError(
				"model_error",
				"connect to https://user:secret@mcp.example.invalid token=abc123",
				false,
			),
		});
		expect(terminal?.type).toBe("run.failed");
		if (terminal === undefined || terminal.type !== "run.failed") throw new Error("expected run.failed");
		const wireMessage = terminal.receipt.terminalError?.message ?? "";
		expect(wireMessage).not.toContain("secret");
		expect(wireMessage).not.toContain("abc123");
		expect(wireMessage).toContain("[redacted]");

		// retained record is redacted
		expect(run.record.terminalError?.message).not.toContain("secret");
		expect(run.record.terminalError?.message).not.toContain("abc123");

		// persisted ledger entry is redacted
		const terminalEntry = session
			.getEntries()
			.filter(isAutomationRunEntry)
			.find((entry) => (entry.data as { kind?: string }).kind === "terminal");
		const persisted = (terminalEntry?.data as { receipt?: { terminalError?: AutomationError } }).receipt?.terminalError;
		expect(persisted?.message).toBeDefined();
		expect(persisted?.message).not.toContain("secret");
		expect(persisted?.message).not.toContain("abc123");
	});

	it("redacts a hand-written terminal error when replayed from the ledger", () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: { id: "r-raw", sessionId: session.getSessionId(), attempt: 1, status: "failed", model: MODEL },
		});
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: "2026-08-10T12:00:04.000Z",
			receipt: {
				runId: "r-raw",
				sessionId: session.getSessionId(),
				status: "failed",
				usage: { input: 0, output: 0, total: 0 },
				terminalError: createAutomationError("model_error", "Bearer abc.def.ghi token=xyz", false),
			},
		});

		const coordinator = makeCoordinator(session);
		const result = coordinator.getRun("r-raw");
		expect(result?.receipt?.terminalError?.message).toBe("[redacted] token=[redacted]");
		expect(result?.record.terminalError?.message).toBe("[redacted] token=[redacted]");
	});
});
