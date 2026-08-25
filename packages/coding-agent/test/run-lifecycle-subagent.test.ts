import { describe, expect, it } from "vitest";
import {
	createRunLifecycleCoordinator,
	registerRunSubagentLifecycleHooks,
	type RunSubagentLifecycleHooks,
} from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";

const MODEL = { provider: "faux", id: "faux-model", thinkingLevel: "high" as const };

describe("Run lifecycle Subagent wiring", () => {
	it("propagates cancel, deadline, terminal, and interrupted observations without another terminal authority", async () => {
		const session = SessionManager.inMemory("/workspace/subagent-run", { id: "subagent-session" });
		const observed: string[] = [];
		const hooks: RunSubagentLifecycleHooks = {
			onRunCancelRequested: (runId) => observed.push(`cancel:${runId}`),
			onRunDeadlineExceeded: (runId) => observed.push(`deadline:${runId}`),
			onRunTerminal: (runId, receipt) => observed.push(`terminal:${runId}:${receipt.status}`),
			onRunInterrupted: (runId) => observed.push(`interrupted:${runId}`),
		};
		const unregister = registerRunSubagentLifecycleHooks(session, hooks);
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const cancelled = coordinator.reserve().accept({ runId: "run-cancel", attempt: 1, model: MODEL });
		cancelled.start();
		cancelled.requestCancel();
		cancelled.requestCancel();
		await observeCanonicalTerminal(session, cancelled, { outcome: "cancelled" });
		const deadline = coordinator.reserve().accept({ runId: "run-deadline", attempt: 1, model: MODEL });
		deadline.start();
		deadline.requestDeadlineExceeded();
		await observeCanonicalTerminal(session, deadline, {
			outcome: "failed",
			terminalErrorCode: "run_deadline_exceeded",
		});
		expect(observed).toEqual([
			"cancel:run-cancel",
			"terminal:run-cancel:cancelled",
			"deadline:run-deadline",
			"terminal:run-deadline:failed",
		]);
		expect(cancelled.receipt()?.status).toBe("cancelled");
		expect(deadline.receipt()?.status).toBe("failed");
		unregister();
	});

	it("is default-off and enforces one registered owner per Session identity", async () => {
		const session = SessionManager.inMemory("/workspace/subagent-owner", { id: "subagent-owner" });
		const plain = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const plainRun = plain.reserve().accept({ runId: "plain-run", attempt: 1, model: MODEL });
		plainRun.start();
		await observeCanonicalTerminal(session, plainRun, { outcome: "completed" });
		const unregister = registerRunSubagentLifecycleHooks(session, {});
		expect(() => registerRunSubagentLifecycleHooks(session, {})).toThrow(expect.objectContaining({ code: "service_conflict" }));
		expect(() => createRunLifecycleCoordinator(session, { subagentHooks: {}, diagnostics: () => {} })).toThrow(expect.objectContaining({ code: "service_conflict" }));
		unregister();
	});
});
