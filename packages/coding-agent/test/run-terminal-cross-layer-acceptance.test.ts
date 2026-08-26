import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Session } from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import { projectAutomationRuns } from "../src/core/automation-run-projection.ts";
import { ExecutionAuditQuery } from "../src/core/execution-audit-query.ts";
import {
	createRunLifecycleCoordinator,
	RUN_LEDGER_CUSTOM_TYPE,
	serializePublicRunReceipt,
	type PublicRunReceipt,
	type RunHandle,
	type RunLifecycleCoordinator,
} from "../src/core/run-lifecycle.ts";
import { createSessionManagerStorage } from "../src/core/session-manager-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	observeCanonicalTerminal,
	writeCanonicalRunResult,
	type CanonicalTerminalOptions,
} from "./support/canonical-run-terminal.ts";

const MODEL = { provider: "acceptance", id: "canonical", thinkingLevel: "off" } as const;

function sourceFiles(root: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
	}
	return files.sort();
}

function acceptRun(coordinator: RunLifecycleCoordinator, runId: string): RunHandle {
	return coordinator.reserve().accept({ runId, attempt: 1, model: MODEL });
}

async function canonicalReceiptCount(sessionManager: SessionManager): Promise<number> {
	const session = new Session(createSessionManagerStorage(sessionManager));
	return (
		await session.findFoundationRecords({
			kind: "fact",
			objectType: "run_receipt",
			includePruned: true,
			order: "oldestFirst",
		})
	).length;
}

interface BusinessTerminalInput {
	readonly status: PublicRunReceipt["status"];
	readonly usage: PublicRunReceipt["usage"];
	readonly terminalError?: { readonly code: string; readonly retryable?: boolean };
}

function businessTerminalView(runId: string, receipt: BusinessTerminalInput) {
	return {
		runId,
		status: receipt.status,
		usage: receipt.usage,
		terminalError:
			receipt.terminalError === undefined
				? undefined
				: { code: receipt.terminalError.code, retryable: receipt.terminalError.retryable },
	};
}

describe("canonical Run terminal cross-layer acceptance", () => {
	it("keeps the sole business terminal writer in Foundation settlement", () => {
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const sourceRoots = [
			resolve(repositoryRoot, "packages/agent/src"),
			resolve(repositoryRoot, "packages/coding-agent/src"),
		];
		const sources = sourceRoots.flatMap((root) =>
			sourceFiles(root).map((path) => ({
				path: relative(repositoryRoot, path).replaceAll("\\", "/"),
				text: readFileSync(path, "utf8"),
			})),
		);
		const durableRunReceiptWriters = sources.flatMap((source) =>
			[...source.text.matchAll(/\b(?:appendFact|persistFact)\s*\(\s*["']run_receipt["']/g)].map(
				() => source.path,
			),
		);
		const retiredTransportWriters = sources.flatMap((source) =>
			[...source.text.matchAll(/\bappendCustomEntry\s*\(\s*["']automation\.run["']/g)].map(() => source.path),
		);

		expect(durableRunReceiptWriters).toEqual(["packages/agent/src/harness/foundation/settlement.ts"]);
		expect(retiredTransportWriters).toEqual([]);
	});

	it("fails an injected Automation started append and recovers accepted-only state after restart", async () => {
		const session = SessionManager.inMemory("/workspace/automation-append-failure");
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const run = acceptRun(coordinator, "run-append-failure");
		const append = session.appendCustomEntry.bind(session);
		const spy = vi.spyOn(session, "appendCustomEntry").mockImplementation((customType, data) => {
			if (
				customType === RUN_LEDGER_CUSTOM_TYPE &&
				typeof data === "object" &&
				data !== null &&
				"kind" in data &&
				data.kind === "started"
			) {
				throw new Error("injected Automation append failure");
			}
			return append(customType, data);
		});

		try {
			expect(() => run.start()).toThrow(expect.objectContaining({ code: "ledger_persistence_failed" }));
		} finally {
			spy.mockRestore();
		}

		const restarted = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		expect(restarted.getRun(run.runId)).toMatchObject({
			record: { id: run.runId, status: "accepted" },
			recovery: "interrupted",
		});
		expect(restarted.getRun(run.runId)?.receipt).toBeUndefined();
		expect(await canonicalReceiptCount(session)).toBe(0);
		expect(
			session
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("distinguishes crashes before and after the canonical receipt write", async () => {
		const beforeSession = SessionManager.inMemory("/workspace/crash-before-receipt");
		const beforeRun = acceptRun(createRunLifecycleCoordinator(beforeSession), "run-crash-before");
		beforeRun.start();
		const beforeRestart = createRunLifecycleCoordinator(beforeSession);
		expect(beforeRestart.getRun(beforeRun.runId)).toMatchObject({
			record: { status: "running" },
			recovery: "interrupted",
		});
		expect(beforeRestart.getRun(beforeRun.runId)?.receipt).toBeUndefined();
		expect(await canonicalReceiptCount(beforeSession)).toBe(0);

		const afterSession = SessionManager.inMemory("/workspace/crash-after-receipt");
		const afterRun = acceptRun(createRunLifecycleCoordinator(afterSession), "run-crash-after");
		afterRun.start();
		const canonical = await writeCanonicalRunResult(afterSession, afterRun.runId, { outcome: "completed" });
		const afterRestart = createRunLifecycleCoordinator(afterSession);
		const recovered = afterRestart.getRun(afterRun.runId);
		expect(recovered).toMatchObject({ record: { status: "completed" }, receipt: { status: "completed" } });
		expect(recovered?.receipt).toEqual(serializePublicRunReceipt(recovered!.receipt!));
		expect(recovered?.receipt?.runReceiptId).toBe(canonical.runReceipt.runReceiptId);
		expect(await canonicalReceiptCount(afterSession)).toBe(1);
	});

	it("recovers the canonical terminal when a later Automation append fails", async () => {
		const session = SessionManager.inMemory("/workspace/crash-after-canonical-before-automation");
		const run = acceptRun(createRunLifecycleCoordinator(session), "run-canonical-before-automation-failure");
		run.start();
		const canonical = await writeCanonicalRunResult(session, run.runId, { outcome: "completed" });
		const append = session.appendCustomEntry.bind(session);
		const spy = vi.spyOn(session, "appendCustomEntry").mockImplementation((customType, data) => {
			if (customType === "automation.run") throw new Error("injected Automation append failure");
			return append(customType, data);
		});

		try {
			expect(() =>
				session.appendCustomEntry("automation.run", {
					schemaVersion: 1,
					kind: "terminal",
					endedAt: canonical.runReceipt.completedAt,
					receipt: canonical.runReceipt,
				}),
			).toThrow("injected Automation append failure");
		} finally {
			spy.mockRestore();
		}

		const recovered = createRunLifecycleCoordinator(session).getRun(run.runId);
		expect(recovered).toMatchObject({ record: { status: "completed" }, receipt: { status: "completed" } });
		expect(recovered?.receipt?.runReceiptId).toBe(canonical.runReceipt.runReceiptId);
		expect(await canonicalReceiptCount(session)).toBe(1);
		expect(
			session.getEntries().some((entry) => entry.type === "custom" && entry.customType === "automation.run"),
		).toBe(false);
	});

	it.each([
		{ name: "completed", options: { outcome: "completed" }, eventType: "run.completed", status: "completed", code: undefined },
		{ name: "failed", options: { outcome: "failed", terminalErrorCode: "agent_run_failed" }, eventType: "run.failed", status: "failed", code: "agent_run_failed" },
		{ name: "cancelled", options: { outcome: "cancelled", terminalErrorCode: "user_aborted" }, eventType: "run.cancelled", status: "cancelled", code: "user_aborted" },
		{ name: "deadline", options: { outcome: "failed", terminalErrorCode: "run_deadline_exceeded" }, eventType: "run.failed", status: "failed", code: "run_deadline_exceeded" },
		{ name: "side-effect-unknown", options: { outcome: "failed", sideEffectState: "side_effect_unknown", terminalErrorCode: "side_effect_unknown" }, eventType: "run.failed", status: "failed", code: "side_effect_unknown" },
	] as const)("projects the $name outcome from one canonical receipt", async ({ name, options, eventType, status, code }) => {
		const session = SessionManager.inMemory(`/workspace/outcome-${name}`);
		const run = acceptRun(createRunLifecycleCoordinator(session), `run-${name}`);
		run.start();
		const observed = await observeCanonicalTerminal(session, run, options satisfies CanonicalTerminalOptions);

		expect(observed.event?.type).toBe(eventType);
		expect(run.receipt()).toMatchObject({
			runId: run.runId,
			sessionId: session.getSessionId(),
			status,
			sideEffectState: options.sideEffectState ?? "none",
			usage: { input: 0, output: 0, total: 0 },
		});
		expect(run.receipt()?.terminalError?.code).toBe(code);
		expect("finalText" in run.receipt()!).toBe(false);
		expect("capabilityBindingId" in run.receipt()!).toBe(false);
		expect(await canonicalReceiptCount(session)).toBe(1);
	});

	it("keeps SDK, Audit, projection, duplicate, out-of-order, and restart views equal", async () => {
		const session = SessionManager.inMemory("/workspace/cross-layer-parity");
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const run = acceptRun(coordinator, "run-cross-layer-parity");
		run.start();
		const observed = await observeCanonicalTerminal(session, run, {
			outcome: "completed",
			usage: { input: 13, output: 8, total: 21 },
		});
		if (observed.event === undefined || !("receipt" in observed.event)) throw new Error("missing terminal event");
		expect(observed.event.sequence).toBe(2);
		expect(observed.canonical.writtenEvent.sequence).toBeGreaterThan(observed.event.sequence);
		expect(observed.event.eventId).toBe(observed.canonical.writtenEvent.eventId);
		const receipt = run.receipt();
		if (receipt === undefined) throw new Error("missing public receipt");

		const sdkView = businessTerminalView(run.runId, serializePublicRunReceipt(receipt));
		const restarted = createRunLifecycleCoordinator(session, { diagnostics: () => {} }).getRun(run.runId);
		if (restarted?.receipt === undefined) throw new Error("missing restarted receipt");
		const restartView = businessTerminalView(run.runId, serializePublicRunReceipt(restarted.receipt));
		const audit = new ExecutionAuditQuery(session).replay(run.runId).run;
		const auditView = {
			runId: run.runId,
			status: audit.status,
			usage: audit.usage,
			terminalError: audit.terminalError,
		};
		const projected = projectAutomationRuns({
			canonicalRuns: [observed.canonical, structuredClone(observed.canonical)],
			events: [structuredClone(observed.canonical.writtenEvent), observed.canonical.writtenEvent].reverse(),
		});

		expect(restartView).toEqual(sdkView);
		expect(auditView).toEqual(sdkView);
		expect(businessTerminalView(run.runId, projected[0]!.terminal)).toEqual(sdkView);
		expect(run.observeCanonicalResult(observed.canonical)).toBeUndefined();
		expect(coordinator.diagnostics()).toContainEqual({ kind: "duplicate-terminal", runId: run.runId });
		expect(await canonicalReceiptCount(session)).toBe(1);
	});
});
