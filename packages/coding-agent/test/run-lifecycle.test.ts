import type { AssistantMessage } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/session/agent-session.ts";
import {
	buildCapabilityCatalog,
	resolveCapabilityBinding,
	type CapabilityBinding,
} from "../src/core/policy/capability-registry.ts";
import {
	resolveExecutionPolicy,
	type ExecutionPolicyProfile,
	type PolicyResolutionResult,
} from "../src/core/policy/execution.ts";
import {
	POLICY_APPROVAL_CUSTOM_TYPE,
	POLICY_DECISION_CUSTOM_TYPE,
} from "../src/core/policy/execution-ledger.ts";
import {
	CAPABILITY_BINDING_CUSTOM_TYPE,
	canonicalizeRunRequest,
	createAutomationError,
	createRunRequestFingerprint,
	createRunLifecycleCoordinator,
	foldCapabilityBindingEntries,
	isOpaqueCapabilityBindingId,
	isOpaqueCapabilityDescriptorId,
	isOpaqueCapabilityRevision,
	isTerminalStatus,
	redactAutomationError,
	redactErrorText,
	RUN_LEDGER_CUSTOM_TYPE,
	serializePublicCapabilityBinding,
	serializePublicSessionEntry,
	serializePublicRunReceipt,
	serializePublicRunRecord,
	serializePublicRunStreamEvent,
	serializePublicSessionEvent,
	serializePublicSessionTreeNode,
	type AutomationError,
	type CapabilityBindingLedgerRecord,
	type RunHandle,
	type RunFinalModelReference,
	type RunLedgerSession,
	type RunLifecycleCoordinator,
	type RunModelAttemptSummary,
	type RunModelBudgetSummary,
	type RunModelReference,
	type PublicRunReceipt,
	type RunRecord,
	type RunReservation,
	type RunResult,
} from "../src/core/session/run-lifecycle.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { SessionManager, type SessionEntry, type SessionTreeNode } from "../src/core/session/manager.ts";
import {
	observeCanonicalTerminal,
	type CanonicalTerminalOutcome,
} from "./support/canonical-run-terminal.ts";

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
const FINAL_MODEL: RunFinalModelReference = { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" };
const MODEL_ATTEMPTS: RunModelAttemptSummary[] = [
	{
		attemptId: "attempt:1",
		bindingId: "model-binding:route:production",
		candidate: FINAL_MODEL,
		order: 0,
		status: "completed",
	startedAt: "2026-08-12T00:00:01.000Z",
	endedAt: "2026-08-12T00:00:02.000Z",
	usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
	visibleOutput: false,
	contextSnapshotId: "snapshot:attempt-1",
	},
];
const MODEL_BUDGET: RunModelBudgetSummary = {
	modelCalls: 1,
	inputTokens: 100,
	outputTokens: 20,
		totalTokens: 120,
	maxModelCalls: 3,
	maxTotalTokens: 300,
	exceeded: false,
};

/** Metadata-only redacted binding used by capability-related coordinator tests. */
const BINDING: CapabilityBindingLedgerRecord = {
	id: "binding:default:abc123",
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [{ id: "builtin_tool:core:read", revision: "rev:1", exposedToolName: "Read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read"],
};

const POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "host-safe",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "ask", inheritEnvironment: false, allowEnvironment: ["PATH"] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
};

function resolveLifecyclePolicy(options: {
	runId: string;
	previousPolicyBindingId?: string;
}): Extract<PolicyResolutionResult, { ok: true }> {
	const resolved = resolveExecutionPolicy({
		profiles: { [POLICY_PROFILE.id]: POLICY_PROFILE },
		defaultProfile: POLICY_PROFILE.id,
		runId: options.runId,
		workspaceIdentity: "workspace-policy-lifecycle",
		createdAt: "2026-08-13T00:00:00.000Z",
		previousPolicyBindingId: options.previousPolicyBindingId,
		operation: {
			resource: "process.spawn",
			source: "user_bash",
			id: `request-${options.runId}`,
			command: "cat C:\\private\\secret.txt",
			args: ["--token", "secret"],
			cwd: "C:\\private",
			environmentNames: ["PATH"],
		},
	});
	if (!resolved.ok) throw resolved.error;
	if (resolved.decision === undefined || resolved.approval === undefined) {
		throw new Error("expected ask decision and approval");
	}
	return resolved;
}

function makeSession(): SessionManager {
	const session = SessionManager.inMemory("/workspace/automation");
	runSessions.set(session.getSessionId(), session);
	return session;
}

const runSessions = new Map<string, SessionManager>();
const canonicalResults = new WeakMap<RunHandle, Awaited<ReturnType<typeof observeCanonicalTerminal>>["canonical"]>();

interface CanonicalSettlementInput {
	readonly outcome: CanonicalTerminalOutcome;
	readonly terminalError?: AutomationError;
	readonly currentUsage?: { readonly input: number; readonly output: number; readonly total: number };
}

async function settleRun(run: RunHandle, input: CanonicalSettlementInput) {
	const existing = canonicalResults.get(run);
	if (existing !== undefined) return run.observeCanonicalResult(existing);
	const session = runSessions.get(run.sessionId);
	if (session === undefined) throw new Error(`Missing SessionManager for ${run.sessionId}`);
	const outcome = run.cancelled ? "cancelled" : input.outcome;
	const observed = await observeCanonicalTerminal(session, run, {
			outcome,
			...(outcome !== "failed" || input.terminalError === undefined
				? {}
				: { terminalErrorCode: input.terminalError.code }),
			...(input.currentUsage === undefined ? {} : { usage: run.computeUsageDelta(input.currentUsage) }),
		});
	canonicalResults.set(run, observed.canonical);
	return observed.event;
}

function makeCoordinator(
	session?: RunLedgerSession,
	now?: () => string,
	diagnostics?: (message: string) => void,
): RunLifecycleCoordinator {
	const resolved = session ?? makeSession();
	if (resolved instanceof SessionManager) runSessions.set(resolved.getSessionId(), resolved);
	return createRunLifecycleCoordinator(resolved, { now, diagnostics: diagnostics ?? (() => {}) });
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

function ledgerKinds(session: RunLedgerSession): string[] {
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
	it("moves accepted -> running -> completed and never exposes a pending state", async () => {
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
		expect(started[0]).toMatchObject({
			type: "run.started",
			runId: "r1",
			sessionId: session.getSessionId(),
			sequence: 1,
		});

		const terminal = await settleRun(run, { outcome: "completed" });
		expect(terminal?.type).toBe("run.completed");
		expect(run.record.status).toBe("completed");
		expect(run.record.endedAt).toBeDefined();
		expect(run.receipt()).toMatchObject({ runId: "r1", sessionId: session.getSessionId(), status: "completed" });
		expect(isTerminalStatus(run.record.status)).toBe(true);
		expect(isTerminalStatus("accepted")).toBe(false);
		expect(isTerminalStatus("running")).toBe(false);
		expect(coordinator.activeRun).toBeUndefined();
	});

	it("persists the Run deadline without generating a second binding aggregate", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const deadlineAt = "2026-08-14T00:01:00.000Z";
		const run = coordinator.reserve().accept({
			runId: "r-bound",
			attempt: 1,
			model: MODEL,
			deadlineAt,
		});

		expect(run.record.deadlineAt).toBe(deadlineAt);
		expect(run.record.bindingAssociation).toBeUndefined();
		run.start();
		await settleRun(run, { outcome: "completed" });
		expect(run.receipt()).toMatchObject({ runId: "r-bound", status: "completed" });
		expect("deadlineAt" in run.receipt()!).toBe(false);
		expect("bindingAssociation" in run.receipt()!).toBe(false);

		const replayed = makeCoordinator(session).getRun("r-bound");
		expect(replayed?.record.deadlineAt).toBe(deadlineAt);
		expect(replayed?.record.bindingAssociation).toBeUndefined();
		expect(serializePublicRunRecord(replayed!.record).bindingAssociation).toBeUndefined();
		expect("bindingAssociation" in serializePublicRunReceipt(replayed!.receipt!)).toBe(false);
	});

	it("records cancellation intent; cancelled beats completed and failed at settle", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.requestCancel();
		run.requestCancel();
		run.requestDeadlineExceeded();
		expect(run.cancelled).toBe(true);
		run.start();
		const terminal = await settleRun(run, { outcome: "completed" });
		expect(terminal).toMatchObject({ type: "run.cancelled", receipt: { status: "cancelled" } });
		expect(run.receipt()?.status).toBe("cancelled");
	});

	it("records deadline intent as a failed terminal with a stable error code", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "deadline-run");
		run.start();
		run.requestDeadlineExceeded();

		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "The deadline expired.", false),
		});
		expect(terminal).toMatchObject({
			type: "run.failed",
			receipt: {
				status: "failed",
				terminalError: { code: "run_deadline_exceeded", message: "Run failed.", retryable: false },
			},
		});
		expect(run.record.status).toBe("failed");
		expect(run.cancelled).toBe(false);
		expect(run.receipt()?.terminalError?.code).toBe("run_deadline_exceeded");
		expect(await settleRun(run, { outcome: "failed" })).toBeUndefined();
		expect(ledgerKinds(session).filter((kind) => kind === "terminal")).toHaveLength(0);

		const replayed = makeCoordinator(session).getRun("deadline-run");
		expect(replayed?.record.status).toBe("failed");
		expect(replayed?.receipt?.terminalError).toEqual({
			code: "run_deadline_exceeded",
			message: "Run failed.",
			retryable: false,
		});
	});

	it("lets the first cancellation intent beat a late deadline intent", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "cancel-first");
		run.start();
		run.requestCancel();
		run.requestDeadlineExceeded();

		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "The deadline expired.", false),
		});
		expect(terminal).toMatchObject({ type: "run.cancelled", receipt: { status: "cancelled" } });
		expect(run.cancelled).toBe(true);
		expect(run.receipt()?.terminalError).toEqual({
			code: "user_aborted",
			message: "Run failed.",
			retryable: false,
		});
	});

	it("lets the first deadline intent beat a late cancellation intent", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "deadline-first");
		run.start();
		run.requestDeadlineExceeded();
		run.requestCancel();

		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "The deadline expired.", false),
		});
		expect(terminal).toMatchObject({
			type: "run.failed",
			receipt: {
				status: "failed",
				terminalError: { code: "run_deadline_exceeded" },
			},
		});
		expect(run.cancelled).toBe(false);
	});

		it("settles a failed run with a structured public-safe terminal error", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("host_not_initialized", "boom", false),
		});
		expect(terminal?.type).toBe("run.failed");
		expect(run.receipt()?.terminalError).toEqual({
			code: "host_not_initialized",
			message: "Run failed.",
			retryable: false,
		});
		expect(run.record.terminalError?.code).toBe("host_not_initialized");
	});

	it("records the source run id and attempt for a resumed run", async () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		const run = reservation.accept({ runId: "r2", sourceRunId: "r1", attempt: 2, model: MODEL });
		expect(run.record.sourceRunId).toBe("r1");
		expect(run.record.attempt).toBe(2);
	});

	it("canonicalizes request material by structure while excluding raw prompt data", async () => {
		const left = canonicalizeRunRequest({
			command: "run.start",
			sessionId: "session-1",
			message: "secret=not-persisted",
			images: [{ data: "image-bytes", type: "image" }],
			modelRoute: { id: "route-1", candidates: [] },
		});
		const right = canonicalizeRunRequest({
			command: "run.start",
			sessionId: "session-1",
			message: "secret=not-persisted",
			images: [{ type: "image", data: "image-bytes" }],
			modelRoute: { candidates: [], id: "route-1" },
		});
		expect(
			createRunRequestFingerprint({
				command: "run.start",
				sessionId: "session-1",
				message: "secret=not-persisted",
				images: [{ data: "image-bytes", type: "image" }],
				modelRoute: { id: "route-1", candidates: [] },
			}),
		).toBe(
			createRunRequestFingerprint({
				command: "run.start",
				sessionId: "session-1",
				message: "secret=not-persisted",
				images: [{ type: "image", data: "image-bytes" }],
				modelRoute: { candidates: [], id: "route-1" },
			}),
		);
		expect(left).toEqual(right);
		expect(JSON.stringify(left)).not.toContain("secret=not-persisted");
		expect(JSON.stringify(left)).not.toContain("image-bytes");
		expect(
			createRunRequestFingerprint({
				command: "run.start",
				sessionId: "session-1",
				message: "different",
			}),
		).not.toBe(
			createRunRequestFingerprint({
				command: "run.start",
				sessionId: "session-1",
				message: "secret=not-persisted",
			}),
		);
	});

	it("persists and replays a Session-scoped request relation without a second Run", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "request-run",
			attempt: 1,
			model: MODEL,
			requestScope: "start",
			clientRequestId: "request-1",
			requestFingerprint: "a".repeat(64),
		});
		run.start();
		await settleRun(run, { outcome: "completed" });

		const lookup = coordinator.getRunByClientRequestId("request-1");
		expect(lookup?.fingerprint).toBe("a".repeat(64));
		expect(lookup?.result.record.id).toBe("request-run");
		expect(lookup?.result.receipt?.status).toBe("completed");

		const replayed = makeCoordinator(session).getRunByClientRequestId("request-1");
		expect(replayed?.result.record.id).toBe("request-run");
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("keeps an accepted request relation visible when the started append fails", async () => {
		const session = failingSession(1);
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "accepted-only-request",
			attempt: 1,
			model: MODEL,
			requestScope: "start",
			clientRequestId: "request-after-kill-boundary",
			requestFingerprint: "b".repeat(64),
		});
		expect(() => run.start()).toThrow();

		const replayed = makeCoordinator(session).getRunByClientRequestId("request-after-kill-boundary");
		expect(replayed?.result.record.id).toBe("accepted-only-request");
		expect(replayed?.result.record.status).toBe("accepted");
		expect(replayed?.result.receipt).toBeUndefined();
		expect(replayed?.result.recovery).toBe("interrupted");
		expect(
			session
				.getEntries()
				.filter(isAutomationRunEntry)
				.map((entry) => (entry.data as { kind?: string }).kind),
		).toEqual(["accepted"]);
	});

	it("records and replays additive ModelBroker binding, final model, attempts and budget metadata", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "r-model-binding",
			sourceRunId: "r-source",
			attempt: 2,
			model: MODEL,
			modelBindingId: "model-binding:route:production",
			previousModelBindingId: "model-binding:route:old",
			finalModel: FINAL_MODEL,
			modelAttempts: MODEL_ATTEMPTS,
			modelBudget: MODEL_BUDGET,
		});
		expect(run.record.modelBindingId).toBe("model-binding:route:production");
		expect(run.record.previousModelBindingId).toBe("model-binding:route:old");
		expect(run.record.finalModel).toEqual(FINAL_MODEL);
		expect(run.record.modelAttempts).toEqual(MODEL_ATTEMPTS);
		expect(run.record.modelBudget).toEqual(MODEL_BUDGET);

		run.start();
		const terminal = await settleRun(run, { outcome: "completed" });
		expect(terminal).toMatchObject({ type: "run.completed", receipt: { runId: "r-model-binding" } });
		if (terminal === undefined || !("receipt" in terminal)) throw new Error("expected terminal receipt");
		for (const field of ["modelBindingId", "previousModelBindingId", "finalModel", "modelAttempts", "modelBudget"]) {
			expect(field in terminal.receipt).toBe(false);
		}

		const replayed = makeCoordinator(session).getRun("r-model-binding");
		expect(replayed?.record.modelBindingId).toBe("model-binding:route:production");
		expect(replayed?.record.previousModelBindingId).toBe("model-binding:route:old");
		expect(replayed?.record.finalModel).toEqual(FINAL_MODEL);
		expect(replayed?.record.modelAttempts).toEqual(MODEL_ATTEMPTS);
		expect(replayed?.record.modelBudget).toEqual(MODEL_BUDGET);
	});

	it("records Execution Policy binding metadata and safe policy facts", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const policy = resolveLifecyclePolicy({ runId: "r-policy" });

		const run = coordinator.reserve().accept({
			runId: "r-policy",
			attempt: 1,
			model: MODEL,
			policyBinding: policy.binding,
			policyDecision: policy.decision,
			policyApproval: policy.approval,
			policySummary: policy.summary,
		});

		expect(run.record.policyBindingId).toBe(policy.binding.id);
		expect(run.record.previousPolicyBindingId).toBeUndefined();
		expect(run.record.policySummary).toMatchObject({ bindingId: policy.binding.id, outcome: "ask" });
		expect(run.result().policySummary).toMatchObject({ bindingId: policy.binding.id, outcome: "ask" });

		run.start();
		const terminal = await settleRun(run, { outcome: "failed" });
		expect(terminal?.type).toBe("run.failed");
		if (terminal === undefined || !("receipt" in terminal)) throw new Error("expected terminal receipt");
		expect("policyBindingId" in terminal.receipt).toBe(false);
		expect("policySummary" in terminal.receipt).toBe(false);

		const customTypes = session
			.getEntries()
			.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
			.map((entry) => entry.customType);
		expect(customTypes).toEqual(expect.arrayContaining([
			RUN_LEDGER_CUSTOM_TYPE,
			"policy.binding",
			POLICY_DECISION_CUSTOM_TYPE,
			POLICY_APPROVAL_CUSTOM_TYPE,
		]));
		expect(customTypes).not.toContain("automation.run");

		const persisted = JSON.stringify(session.getEntries());
		expect(persisted).not.toContain("secret.txt");
		expect(persisted).not.toContain("--token");
		expect(persisted).not.toContain("C:\\private");

		const publicEntries = session.getEntries().map((entry) => serializePublicSessionEntry(entry));
		expect(JSON.stringify(publicEntries)).not.toContain("secret.txt");
		expect(JSON.stringify(publicEntries)).not.toContain("bindingHash");
		expect(JSON.stringify(publicEntries)).not.toContain("workspaceIdentity");

		const replayed = makeCoordinator(session).getRun("r-policy");
		expect(replayed?.record.policyBindingId).toBe(policy.binding.id);
		expect("policyBindingId" in replayed!.receipt!).toBe(false);
		expect(replayed?.policySummary).toMatchObject({ bindingId: policy.binding.id, outcome: "ask" });
	});

	it("replays resolved approval records with public redaction", async () => {
		const session = makeSession();
		session.appendCustomEntry(POLICY_APPROVAL_CUSTOM_TYPE, {
			schemaVersion: 1,
			sequence: 1,
			record: {
				id: "policy-request:approved",
				requestId: "policy-request:approved",
				bindingId: "policy-binding:approved",
				resource: "process.spawn",
				reasonCode: "policy_approval_required",
				createdAt: "2026-08-13T00:00:00.000Z",
				outcome: "approved",
				source: "rpc",
				scope: { resource: "process.spawn" },
				command: "cat C:\\private\\secret.txt",
				args: ["--token", "secret"],
				path: "C:\\private\\secret.txt",
			},
		});
		session.appendCustomEntry(POLICY_APPROVAL_CUSTOM_TYPE, {
			schemaVersion: 1,
			sequence: 2,
			record: {
				id: "policy-request:rejected",
				requestId: "policy-request:rejected",
				bindingId: "policy-binding:approved",
				resource: "network.connect",
				reasonCode: "policy_approval_required",
				createdAt: "2026-08-13T00:00:01.000Z",
				outcome: "rejected",
				source: "interactive",
				scope: { resource: "network.connect", destinationCount: 1 },
				environment: { API_TOKEN: "secret" },
				headers: { authorization: "Bearer secret" },
			},
		});

		const publicEntries = session.getEntries().map((entry) => serializePublicSessionEntry(entry));
		const approvalEntries = publicEntries.filter(
			(entry) => entry.type === "custom" && entry.customType === POLICY_APPROVAL_CUSTOM_TYPE,
		);
		expect(approvalEntries).toEqual([
			expect.objectContaining({
				data: {
					schemaVersion: 1,
					sequence: 1,
					approval: expect.objectContaining({
						requestId: "policy-request:approved",
						outcome: "approved",
						source: "rpc",
					}),
				},
			}),
			expect.objectContaining({
				data: {
					schemaVersion: 1,
					sequence: 2,
					approval: expect.objectContaining({
						requestId: "policy-request:rejected",
						outcome: "rejected",
						source: "interactive",
					}),
				},
			}),
		]);
		const serialized = JSON.stringify(publicEntries);
		expect(serialized).not.toContain("secret.txt");
		expect(serialized).not.toContain("--token");
		expect(serialized).not.toContain("API_TOKEN");
		expect(serialized).not.toContain("authorization");
		expect(JSON.stringify(session.getTree().map((node) => serializePublicSessionTreeNode(node)))).not.toContain(
			"secret.txt",
		);
	});

	it("redacts structured bash messages and streaming output at the public boundary", async () => {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command: "cat C:\\private\\secret.txt",
			output: "TOKEN=secret",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: "C:\\private\\full-output.txt",
			timestamp: 1,
		};
		const publicEntry = serializePublicSessionEntry({
			type: "message",
			id: "bash-entry",
			parentId: null,
			timestamp: "2026-08-13T00:00:00.000Z",
			message: bashMessage,
		});
		const publicEvent = serializePublicSessionEvent({
			type: "bash_execution_update",
			id: "bash-execution",
			delta: "TOKEN=secret",
		});

		expect(publicEntry).toMatchObject({
			type: "message",
			message: { role: "bashExecution", command: "[redacted]", output: "[redacted]" },
		});
		if (publicEntry.type !== "message") throw new Error("expected a public message entry");
		expect("fullOutputPath" in publicEntry.message).toBe(false);
		expect(publicEvent).toMatchObject({ type: "bash_execution_update", delta: "[redacted]" });
		expect(JSON.stringify({ publicEntry, publicEvent })).not.toContain("secret");
		expect(JSON.stringify({ publicEntry, publicEvent })).not.toContain("C:\\private");
	});

	it("records resume as a successor Execution Policy binding without reusing the source binding", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const firstPolicy = resolveLifecyclePolicy({ runId: "r-policy-1" });
		const first = coordinator.reserve().accept({
			runId: "r-policy-1",
			attempt: 1,
			model: MODEL,
			policyBinding: firstPolicy.binding,
			policyDecision: firstPolicy.decision,
			policyApproval: firstPolicy.approval,
		});
		first.start();
		await settleRun(first, { outcome: "completed" });

		const secondPolicy = resolveLifecyclePolicy({
			runId: "r-policy-2",
			previousPolicyBindingId: firstPolicy.binding.id,
		});
		const second = coordinator.reserve().accept({
			runId: "r-policy-2",
			sourceRunId: "r-policy-1",
			previousPolicyBindingId: firstPolicy.binding.id,
			attempt: 2,
			model: MODEL,
			policyBinding: secondPolicy.binding,
			policyDecision: secondPolicy.decision,
			policyApproval: secondPolicy.approval,
		});

		expect(second.record.policyBindingId).toBe(secondPolicy.binding.id);
		expect(second.record.previousPolicyBindingId).toBe(firstPolicy.binding.id);
		expect(second.record.policyBindingId).not.toBe(second.record.previousPolicyBindingId);
		expect(secondPolicy.approval?.bindingId).toBe(secondPolicy.binding.id);
		expect(secondPolicy.approval?.id).not.toBe(firstPolicy.approval?.id);
	});

	it("rejects a resumed Run that tries to reuse the previous Execution Policy binding", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const policy = resolveLifecyclePolicy({ runId: "r-policy-reuse" });

		let error: unknown;
		try {
			coordinator.reserve().accept({
				runId: "r-policy-reuse",
				sourceRunId: "r-source",
				previousPolicyBindingId: policy.binding.id,
				attempt: 2,
				model: MODEL,
				policyBinding: policy.binding,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({ code: "policy_binding_failed" });

		expect(session.getEntries().filter(isAutomationRunEntry)).toHaveLength(0);
	});
});

describe("model_error terminal code", () => {
		it("stores a fixed public-safe message on the run.failed receipt and terminal event", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});
		expect(terminal?.type).toBe("run.failed");
		expect(terminal).toMatchObject({
			receipt: { status: "failed", terminalError: { code: "model_error", message: "Run failed." } },
		});
		expect(run.receipt()?.terminalError).toEqual({
			code: "model_error",
			message: "Run failed.",
			retryable: false,
		});
		expect(run.record.status).toBe("failed");
		expect(run.record.terminalError?.code).toBe("model_error");
	});

	it("persists model_error only through the canonical Foundation receipt", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});
		expect(run.receipt()?.terminalError).toEqual({
			code: "model_error",
			message: "Run failed.",
			retryable: false,
		});
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("replays a model_error failed receipt from the ledger", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("model_error", "529 overloaded_error: Overloaded", false),
		});

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result?.record.status).toBe("failed");
		expect(result?.receipt?.terminalError).toEqual({
			code: "model_error",
			message: "Run failed.",
			retryable: false,
		});
		expect(result?.record.terminalError?.code).toBe("model_error");
		expect(result?.recovery).toBeUndefined();
	});

	it("rejects a hand-written terminal in the current transport ledger", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: { id: "r-model", sessionId: session.getSessionId(), attempt: 1, status: "accepted", model: MODEL },
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
		expect(result?.record.status).toBe("accepted");
		expect(result?.receipt).toBeUndefined();
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(true);
	});
});

describe("duplicate terminal / late events / cancellation", () => {
	it("ignores a second terminal, records a duplicate-terminal diagnostic, and persists one terminal fact", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const first = await settleRun(run, { outcome: "completed" });
		expect(first?.type).toBe("run.completed");

		const second = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("host_not_initialized", "late", false),
		});
		expect(second).toBeUndefined();
		expect(run.receipt()?.status).toBe("completed");
		expect(coordinator.diagnostics().some((diag) => diag.kind === "duplicate-terminal")).toBe(true);
		expect(ledgerKinds(session).filter((kind) => kind === "terminal")).toHaveLength(0);
	});

	it("ignores a late cancel after the run is already terminal", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });
		run.requestCancel();
		run.requestDeadlineExceeded();
		expect(run.receipt()?.status).toBe("completed");
		expect(run.terminal?.type).toBe("run.completed");
	});

	it("drops session events captured after the run is terminal", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });
		const before = run.emitted.length;
		expect(run.captureSessionEvent(agentEnd([assistantMessage("late")]))).toBeUndefined();
		expect(run.emitted.length).toBe(before);
		expect(run.emitted.every((event) => event.type !== "run.event")).toBe(true);
	});
});

describe("per-session reservation", () => {
	it("rejects a second concurrent reservation with a retryable session_busy error", async () => {
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

	it("frees the session when a reservation is released without accepting", async () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		reservation.release();
		expect(coordinator.getActiveRun()).toBeUndefined();
		expect(() => coordinator.reserve()).not.toThrow();
	});

	it("frees the session once the run is terminal and a new run can be reserved", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });
		expect(coordinator.getActiveRun()).toBeUndefined();
		const next = accept(coordinator.reserve(), "r2");
		expect(next.runId).toBe("r2");
		expect(next.record.status).toBe("accepted");
	});

	it("rejects re-accepting a consumed reservation", async () => {
		const coordinator = makeCoordinator();
		const reservation = coordinator.reserve();
		accept(reservation, "r1");
		expect(() => reservation.accept({ runId: "r2", attempt: 1, model: MODEL })).toThrow();
	});

	it("auto-generates distinct run ids across separate coordinators", async () => {
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
	it("buffers pre-start events and flushes them after the sequence-1 started event", async () => {
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
		expect((events[1] as Extract<(typeof events)[number], { type: "run.event" }>).event.type).toBe("agent_end");

		const terminal = await settleRun(run, { outcome: "completed" });
		expect(terminal?.sequence).toBe(5);
		expect(run.emitted.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
	});

	it("keeps the public sequence continuous when it overtakes Foundation physical ordering", async () => {
		const session = makeSession();
		const run = accept(makeCoordinator(session).reserve(), "r-sequence-domains");
		run.start();
		for (let index = 0; index < 20; index += 1) run.captureSessionEvent(settled());

		const observed = await observeCanonicalTerminal(session, run, { outcome: "completed" });
		if (observed.event === undefined) throw new Error("expected canonical terminal event");
		expect(observed.event.sequence).toBe(22);
		expect(observed.canonical.writtenEvent.sequence).toBeLessThan(observed.event.sequence);
		expect(run.emitted.map((event) => event.sequence)).toEqual(
			run.emitted.map((_, index) => index + 1),
		);
	});

	it("returns exactly one wrapped run.event per captured session event while running", async () => {
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

	it("wraps events captured after start without reordering the stream", async () => {
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

	it("keeps assistant text on stream events and out of the canonical receipt", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.captureSessionEvent(messageEnd(assistantMessage("hello ")));
		run.captureSessionEvent(messageEnd(assistantMessage("world")));
		run.captureSessionEvent(agentEnd([assistantMessage("earlier"), assistantMessage("final answer")]));
		run.start();
		await settleRun(run, { outcome: "completed" });
		expect(JSON.stringify(run.emitted)).toContain("final answer");
		expect("finalText" in run.receipt()!).toBe(false);
	});
});

describe("usage deltas", () => {
	it("computes non-negative usage deltas against the baseline", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.setUsageBaseline({ input: 100, output: 20, total: 120 });
		expect(run.computeUsageDelta({ input: 150, output: 25, total: 180 })).toEqual({
			input: 50,
			output: 5,
			total: 60,
		});
		expect(run.computeUsageDelta({ input: 80, output: 10, total: 100 })).toEqual({ input: 0, output: 0, total: 0 });
	});

	it("writes the usage delta into the terminal receipt", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.setUsageBaseline({ input: 10, output: 5, total: 15 });
		run.start();
		await settleRun(run, { outcome: "completed", currentUsage: { input: 40, output: 15, total: 60 } });
		expect(run.receipt()?.usage).toEqual({ input: 30, output: 10, total: 45 });
	});
});

describe("ledger persistence and context isolation", () => {
	it("persists only accepted/started transport facts beside the Foundation terminal", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("keeps custom entries out of the model context while preserving entries and tree", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });

		const context = session.buildSessionContext();
		expect(context.messages).toEqual([]);

		session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
		const context2 = session.buildSessionContext();
		expect(context2.messages).toHaveLength(1);
		expect(context2.messages[0].role).toBe("user");

		const entries: SessionEntry[] = session.getEntries();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE)).toBe(
			true,
		);

		const tree = session.getTree();
		const flat = flattenTree(tree);
		expect(
			flat.some((node) => node.entry.type === "custom" && node.entry.customType === RUN_LEDGER_CUSTOM_TYPE),
		).toBe(true);
	});
});

describe("persistence failures", () => {
	it("surfaces a ledger persistence failure at start without emitting events", async () => {
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

	it("does not append an Automation terminal after accepted and started transport facts", async () => {
		const session = failingSession(2);
		const requestCoordinator = createRunLifecycleCoordinator(session, { diagnostics: () => {} });
		const run = requestCoordinator.reserve().accept({
			runId: "terminal-boundary-request",
			attempt: 1,
			model: MODEL,
			requestScope: "start",
			clientRequestId: "terminal-boundary-1",
			requestFingerprint: "c".repeat(64),
		});
		run.start();
		let error: AutomationError | undefined;
		try {
			await settleRun(run, { outcome: "completed" });
		} catch (caught) {
			error = caught as AutomationError;
		}
		expect(error).toBeUndefined();
		expect(run.receipt()?.status).toBe("completed");
		expect(run.record.status).toBe("completed");
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("observes one canonical deadline terminal and rejects a duplicate observation", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "deadline-persistence");
		run.start();
		run.requestDeadlineExceeded();

		const terminal = await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "deadline", false),
		});
		expect(terminal).toMatchObject({
			type: "run.failed",
			receipt: { status: "failed", terminalError: { code: "run_deadline_exceeded" } },
		});
		expect(await settleRun(run, { outcome: "failed" })).toBeUndefined();
		expect(ledgerKinds(session).filter((kind) => kind === "terminal")).toHaveLength(0);
	});

	it("consumes and releases the reservation when persisting the accepted fact fails", async () => {
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
	it("rebuilds a completed run with receipt from the SessionManager custom entries", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.captureSessionEvent(agentEnd([assistantMessage("final")]));
		run.start();
		await settleRun(run, { outcome: "completed", currentUsage: { input: 30, output: 5, total: 35 } });

		const c2 = makeCoordinator(session);
		const index = c2.rebuildIndex();
		const result = index.get("r1");
		expect(result).toBeDefined();
		expect(result?.record.status).toBe("completed");
		expect(result?.record.attempt).toBe(1);
		expect(result?.record.startedAt).toBeDefined();
		expect(result?.record.endedAt).toBeDefined();
		expect(result?.receipt?.status).toBe("completed");
		expect("finalText" in result!.receipt!).toBe(false);
		expect(result?.receipt?.usage).toEqual({ input: 30, output: 5, total: 35 });
		expect(result?.recovery).toBeUndefined();
		expect(c2.getRun("r1")).toEqual(result);
	});

	it("skips malformed, unknown-version, unknown-kind and orphan entries without breaking recovery", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });

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

	it("delivers replay diagnostics to the diagnostics sink", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, "garbage");
		const sink: string[] = [];
		const coordinator = createRunLifecycleCoordinator(session, { diagnostics: (message) => sink.push(message) });
		coordinator.rebuildIndex();
		expect(sink.some((message) => message.includes("malformed"))).toBe(true);
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(true);
	});

	it("does not mutate the persisted accepted record when replay applies later facts", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });

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

	it("keeps the canonical receipt when replay sees an invalid transport terminal", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });

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
		expect(c2.diagnostics().some((diag) => diag.kind === "malformed")).toBe(true);
	});

	it("skips schema-1 malformed accepted and terminal facts without crashing", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = accept(c1.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });

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
	it("recovers an interrupted run as non-terminal without fabricating a terminal fact", async () => {
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

	it("flags an accepted-but-never-started run as interrupted too", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		c1.reserve().accept({ runId: "r1", attempt: 1, model: MODEL });

		const c2 = makeCoordinator(session);
		const result = c2.rebuildIndex().get("r1");
		expect(result?.record.status).toBe("accepted");
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");
	});

	it("returns a fresh live result from getRun after settle", async () => {
		const coordinator = makeCoordinator();
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		await settleRun(run, { outcome: "completed" });
		expect(coordinator.getRun("r1")?.record.status).toBe("completed");
		expect(coordinator.getRun("missing")).toBeUndefined();
	});
});

describe("credential lifecycle hooks", () => {
	it("fires onRunTerminal once with the final receipt after settle", async () => {
		const session = makeSession();
		const terminalCalls: Array<{ runId: string; status: string; deadline: boolean }> = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunTerminal: (runId, receipt) => {
					terminalCalls.push({
						runId,
						status: receipt.status,
						deadline: receipt.terminalError?.code === "run_deadline_exceeded",
					});
				},
			},
		});
		const run = accept(coordinator.reserve(), "r-hook");
		run.start();
		expect(terminalCalls).toEqual([]);
		await settleRun(run, { outcome: "completed" });
		expect(terminalCalls).toEqual([{ runId: "r-hook", status: "completed", deadline: false }]);
		// A duplicate settle never fires the hook again.
		await settleRun(run, { outcome: "completed" });
		expect(terminalCalls).toHaveLength(1);
		// The hook never rewrites the ledger: the terminal receipt is untouched.
		expect(coordinator.getRun("r-hook")?.record.status).toBe("completed");
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("exposes the deadline via the receipt terminal error code", async () => {
		const session = makeSession();
		const terminalCalls: Array<{ status: string; code?: string }> = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunTerminal: (runId, receipt) => {
					terminalCalls.push({ status: receipt.status, code: receipt.terminalError?.code });
				},
			},
		});
		const run = accept(coordinator.reserve(), "r-deadline");
		run.start();
		run.requestDeadlineExceeded();
		await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "deadline", false),
		});
		expect(terminalCalls).toEqual([{ status: "failed", code: "run_deadline_exceeded" }]);
	});

	it("fires onRunInterrupted once per recovered run and never for live or settled runs", async () => {
		const session = makeSession();
		// A live run settles normally; a second run stays interrupted.
		const c1 = createRunLifecycleCoordinator(session, { now: () => "2026-08-10T12:00:00.000Z", diagnostics: () => {} });
		const live = accept(c1.reserve(), "r-live");
		live.start();
		await settleRun(live, { outcome: "completed" });
		const interrupted = accept(c1.reserve(), "r-interrupted");
		interrupted.start();

		const interruptedCalls: string[] = [];
		const c2 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:00.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunInterrupted: (runId) => interruptedCalls.push(runId),
			},
		});
		const rebuilt = c2.rebuildIndex();
		expect(rebuilt.get("r-live")?.receipt).toBeDefined();
		expect(rebuilt.get("r-interrupted")?.recovery).toBe("interrupted");
		expect(interruptedCalls).toEqual(["r-interrupted"]);
		// Rebuilds are idempotent: the hook fires at most once per run.
		c2.rebuildIndex();
		c2.getRun("r-interrupted");
		expect(interruptedCalls).toEqual(["r-interrupted"]);
		// A fresh coordinator instance signals the recovered run again (restart).
		const c3 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:00.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunInterrupted: (runId) => interruptedCalls.push(runId),
			},
		});
		c3.rebuildIndex();
		expect(interruptedCalls).toEqual(["r-interrupted", "r-interrupted"]);
	});

	it("never reports a live run as interrupted", async () => {
		const session = makeSession();
		const interruptedCalls: string[] = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:00.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunInterrupted: (runId) => interruptedCalls.push(runId),
			},
		});
		const run = accept(coordinator.reserve(), "r-live");
		run.start();
		coordinator.rebuildIndex();
		expect(interruptedCalls).toEqual([]);
		expect(coordinator.getRun("r-live")?.record.status).toBe("running");
	});

	it("terminal and interrupted observations fire only after the Run facts are persisted", async () => {
		const session = makeSession();
		const observed: Array<{ runId: string; kinds: string[] }> = [];
		const c1 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunTerminal: (runId) => observed.push({ runId, kinds: ledgerKinds(session) }),
				onRunInterrupted: (runId) => observed.push({ runId, kinds: ledgerKinds(session) }),
			},
		});
		const run = accept(c1.reserve(), "r-order");
		run.start();
		await settleRun(run, { outcome: "completed" });
		// The terminal observer sees transport facts only after the Foundation terminal is durable.
		expect(observed).toEqual([{ runId: "r-order", kinds: ["accepted", "started"] }]);

		// A recovered run without a terminal receipt is observed only after its
		// accepted/started facts are folded from the persisted ledger.
		const c2 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunInterrupted: (runId) => observed.push({ runId, kinds: ledgerKinds(session) }),
			},
		});
		const interrupted = accept(c2.reserve(), "r-order-int");
		interrupted.start();
		const c3 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunInterrupted: (runId) => observed.push({ runId, kinds: ledgerKinds(session) }),
			},
		});
		c3.rebuildIndex();
		// The recovered run's own accepted/started facts are the last two entries
		// in the append-only ledger and are persisted before the observer fires.
		expect(observed[1].kinds.slice(-2)).toEqual(["accepted", "started"]);
	});

	it("fires onRunCancelRequested once on the first cancel request only", async () => {
		const session = makeSession();
		const cancelCalls: string[] = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunCancelRequested: (runId) => cancelCalls.push(runId),
			},
		});
		const run = accept(coordinator.reserve(), "r-cancel");
		run.start();
		run.requestCancel();
		expect(cancelCalls).toEqual(["r-cancel"]);
		// A duplicate cancel request never fires the observer again.
		run.requestCancel();
		run.requestCancel();
		expect(cancelCalls).toEqual(["r-cancel"]);
		// The observer is a side channel: no Run fact was written by the request.
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
		// The terminal still settles through the normal gate, once.
		await settleRun(run, { outcome: "completed" });
		expect(coordinator.getRun("r-cancel")?.record.status).toBe("cancelled");
		expect(cancelCalls).toEqual(["r-cancel"]);
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("never fires onRunCancelRequested for settle without a cancel request or after terminal", async () => {
		const session = makeSession();
		const cancelCalls: string[] = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunCancelRequested: (runId) => cancelCalls.push(runId),
			},
		});
		// A run that settles completed without an explicit request never fires it.
		const direct = accept(coordinator.reserve(), "r-direct");
		direct.start();
		await settleRun(direct, { outcome: "completed" });
		expect(cancelCalls).toEqual([]);
		expect(coordinator.getRun("r-direct")?.record.status).toBe("completed");
		// A request after the terminal fact is ignored.
		direct.requestCancel();
		expect(cancelCalls).toEqual([]);
		// A deadline request is not a cancel request.
		const deadline = accept(coordinator.reserve(), "r-deadline-cancel");
		deadline.start();
		deadline.requestDeadlineExceeded();
		expect(cancelCalls).toEqual([]);
		await settleRun(deadline, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "deadline", false),
		});
		expect(cancelCalls).toEqual([]);
	});

	it("a cancel request that loses a deadline race never fires the observer", async () => {
		const session = makeSession();
		const cancelCalls: string[] = [];
		const terminalCalls: Array<{ runId: string; status: string }> = [];
		const coordinator = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:01.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunCancelRequested: (runId) => cancelCalls.push(runId),
				onRunTerminal: (runId, receipt) => terminalCalls.push({ runId, status: receipt.status }),
			},
		});
		// Deadline intent wins: the later cancel request is ignored, the terminal
		// observation (failed + run_deadline_exceeded) fires after the fact is
		// persisted, and the cancel observer never fires.
		const run = accept(coordinator.reserve(), "r-race");
		run.start();
		run.requestDeadlineExceeded();
		run.requestCancel();
		expect(cancelCalls).toEqual([]);
		await settleRun(run, {
			outcome: "failed",
			terminalError: createAutomationError("run_deadline_exceeded", "deadline", false),
		});
		expect(terminalCalls).toEqual([{ runId: "r-race", status: "failed" }]);
		expect(coordinator.getRun("r-race")?.record.terminalError?.code).toBe("run_deadline_exceeded");
	});

	it("never fires onRunCancelRequested for a replayed run handle", async () => {
		const session = makeSession();
		const cancelCalls: string[] = [];
		const c1 = createRunLifecycleCoordinator(session, { now: () => "2026-08-10T12:00:00.000Z", diagnostics: () => {} });
		const run = accept(c1.reserve(), "r-replay");
		run.start();
		await settleRun(run, { outcome: "completed" });

		const c2 = createRunLifecycleCoordinator(session, {
			now: () => "2026-08-10T12:00:00.000Z",
			diagnostics: () => {},
			credentialHooks: {
				onRunCancelRequested: (runId) => cancelCalls.push(runId),
			},
		});
		const result = c2.getRun("r-replay");
		expect(result).toBeDefined();
		// `replayedHandle` is impl-internal; the duplicate-request path returns
		// a read-only handle whose requestCancel() is a documented no-op.
		const replayed = (c2 as unknown as { replayedHandle(run: RunResult): RunHandle }).replayedHandle(result!);
		replayed.requestCancel();
		expect(cancelCalls).toEqual([]);
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});
});

describe("structural contract", () => {
	it("is satisfied by a real SessionManager without wrapping", async () => {
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
	it("records capabilityBindingId on the terminal receipt and persists a schemaVersion 1 entry", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "r1",
			attempt: 1,
			model: MODEL,
			capabilityBinding: BINDING,
		});
		run.start();
		const terminal = await settleRun(run, { outcome: "completed" });
		expect(terminal?.type).toBe("run.completed");
		expect(run.record.capabilityBindingId).toBe(BINDING.id);
		expect("capabilityBindingId" in run.receipt()!).toBe(false);

		const bindingEntries = session.getEntries().filter(isCapabilityBindingEntry);
		expect(bindingEntries).toHaveLength(1);
		const persisted = bindingEntries[0].data as { schemaVersion: number; binding: CapabilityBindingLedgerRecord };
		expect(persisted.schemaVersion).toBe(1);
		expect(persisted.binding).toEqual(BINDING);
	});

	it("replays capabilityBindingId and previousBindingId from the ledger after recovery", async () => {
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
		await settleRun(run, { outcome: "completed" });

		const c2 = makeCoordinator(session);
		const result = c2.getRun("r2");
		expect(result?.record.sourceRunId).toBe("r1");
		expect(result?.record.previousBindingId).toBe("binding:source:old");
		expect(result?.record.capabilityBindingId).toBe(BINDING.id);
		expect("capabilityBindingId" in result!.receipt!).toBe(false);
		expect(c2.getCapabilityBindings().get(BINDING.id)).toEqual(BINDING);
	});

	it("records previousBindingId on the accepted record without a binding snapshot", async () => {
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

describe("capabilityBindingId on the accepted record", () => {
	it("records capabilityBindingId on the accepted record and its persisted accepted fact", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = coordinator.reserve().accept({
			runId: "r1",
			attempt: 1,
			model: MODEL,
			capabilityBinding: BINDING,
		});
		// The frozen binding id is available before any terminal fact, so an
		// interrupted (never-terminal) run still carries it.
		expect(run.record.capabilityBindingId).toBe(BINDING.id);

		const acceptedFact = session
			.getEntries()
			.filter(isAutomationRunEntry)
			.find((entry) => (entry.data as { kind?: string }).kind === "accepted");
		expect((acceptedFact?.data as { record?: { capabilityBindingId?: string } }).record?.capabilityBindingId).toBe(
			BINDING.id,
		);
	});

	it("accepts a hand-written accepted record with a string capabilityBindingId during runtime parsing", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: "r-binding",
				sessionId: session.getSessionId(),
				attempt: 1,
				status: "accepted",
				model: MODEL,
				capabilityBindingId: "binding:default:abc123",
			},
		});

		const coordinator = makeCoordinator(session);
		const result = coordinator.rebuildIndex().get("r-binding");
		expect(result?.record.capabilityBindingId).toBe("binding:default:abc123");
		expect(result?.recovery).toBe("interrupted");
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(false);
	});

	it("rejects a hand-written accepted record whose capabilityBindingId is not a string", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: "r-bad-binding",
				sessionId: session.getSessionId(),
				attempt: 1,
				status: "accepted",
				model: MODEL,
				capabilityBindingId: 42,
			},
		});

		const coordinator = makeCoordinator(session);
		const index = coordinator.rebuildIndex();
		expect(index.get("r-bad-binding")).toBeUndefined();
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(true);
	});

	it("preserves capabilityBindingId through cloneRunRecord when replaying a terminal run", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		const run = c1.reserve().accept({
			runId: "r1",
			attempt: 1,
			model: MODEL,
			capabilityBinding: BINDING,
		});
		run.start();
		await settleRun(run, { outcome: "completed" });

		const c2 = makeCoordinator(session);
		const result = c2.getRun("r1");
		expect(result?.record.capabilityBindingId).toBe(BINDING.id);
		expect(result?.record.capabilityBindingId).toBe(BINDING.id);
		expect("capabilityBindingId" in result!.receipt!).toBe(false);
	});

	it("recovers capabilityBindingId for an interrupted accepted-only run on replay", async () => {
		const session = makeSession();
		const c1 = makeCoordinator(session);
		// Accepted and never terminal: the process exits before start/settle, so
		// the accepted record is the only source of the binding id.
		c1.reserve().accept({
			runId: "r1",
			attempt: 1,
			model: MODEL,
			capabilityBinding: BINDING,
		});

		const c2 = makeCoordinator(session);
		const result = c2.getRun("r1");
		expect(result?.record.capabilityBindingId).toBe(BINDING.id);
		expect(result?.record.status).toBe("accepted");
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");
	});

	it("keeps historical accepted records without capabilityBindingId valid on replay", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: "r-legacy",
				sessionId: session.getSessionId(),
				sourceRunId: "r0",
				previousBindingId: "binding:source:old",
				attempt: 2,
				status: "accepted",
				model: MODEL,
			},
		});
		const coordinator = makeCoordinator(session);
		const result = coordinator.getRun("r-legacy");
		expect(result).toBeDefined();
		expect(result?.record.capabilityBindingId).toBeUndefined();
		expect(result?.record.sourceRunId).toBe("r0");
		expect(result?.record.previousBindingId).toBe("binding:source:old");
		expect(result?.receipt).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");
		expect(coordinator.diagnostics().some((diag) => diag.kind === "malformed")).toBe(false);
	});
});

describe("capability binding ledger folding", () => {
	it("folds capability.binding custom entries into a redacted history", async () => {
		const session = makeSession();
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 1, binding: BINDING });

		const folded = foldCapabilityBindingEntries(session.getEntries());
		expect(folded.get(BINDING.id)).toEqual(BINDING);

		const coordinator = makeCoordinator(session);
		expect(coordinator.getCapabilityBindings().get(BINDING.id)).toEqual(BINDING);
	});

	it("skips malformed capability.binding entries and reports malformed-binding diagnostics", async () => {
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
	it("keeps tools vs excludeTools same-view bindings distinct through fold, rebuild, replay", async () => {
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
		await settleRun(viaToolsRun, { outcome: "completed" });
		const viaExcludeRun = c1.reserve().accept({
			runId: "r-exclude",
			attempt: 1,
			model: MODEL,
			capabilityBinding: viaExclude,
		});
		viaExcludeRun.start();
		await settleRun(viaExcludeRun, { outcome: "completed" });

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
		expect(viaToolsResult?.record.capabilityBindingId).toBe(viaTools.id);
		expect(viaExcludeResult?.record.capabilityBindingId).toBe(viaExclude.id);
		expect(recovered.get(viaToolsResult?.record.capabilityBindingId ?? "")).toEqual(viaTools);
		expect(recovered.get(viaExcludeResult?.record.capabilityBindingId ?? "")).toEqual(viaExclude);
	});

	it("does not collapse a noTools binding with an empty tools binding after rebuild", async () => {
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
	it("redacts URL userinfo and well-known secret assignments from error text", async () => {
		expect(redactErrorText("connect to https://user:secret@mcp.example.invalid/host failed")).toBe(
			"connect to https://mcp.example.invalid/host failed",
		);
		expect(redactErrorText("authorization: Bearer abc.def.ghi rejected")).toBe("authorization=[redacted] rejected");
		expect(redactErrorText("Bearer abc.def.ghi rejected")).toBe("[redacted] rejected");
		expect(redactErrorText("api_key=hunter2 is invalid")).toBe("api_key=[redacted] is invalid");
		expect(redactErrorText("token=xyz failed")).toBe("token=[redacted] failed");
		expect(redactErrorText("ordinary failure message")).toBe("ordinary failure message");
	});

	it("never leaves a secret payload visible after redaction", async () => {
		const redacted = redactErrorText(
			"auth https://user:pass@mcp.example.invalid authorization: Bearer abc.def.ghi api_key=hunter2 token=xyz password=sesame",
		);
		expect(redacted).not.toMatch(/abc\.def\.ghi|hunter2|xyz|sesame|user:pass/);
	});

	it("redacts an AutomationError message while preserving code and retryable", async () => {
		const error = createAutomationError("capability_mcp_connect_failed", "token=xyz failed", true);
		const redacted = redactAutomationError(error);
		expect(redacted.code).toBe("capability_mcp_connect_failed");
		expect(redacted.retryable).toBe(true);
		expect(redacted.message).toBe("token=[redacted] failed");
	});
});

describe("terminal error redaction", () => {
	it("replaces a terminalError before canonical persistence, emission and the retained record", async () => {
		const session = makeSession();
		const coordinator = makeCoordinator(session);
		const run = accept(coordinator.reserve(), "r1");
		run.start();
		const terminal = await settleRun(run, {
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
		expect(wireMessage).toBe("Run failed.");

		// retained record is redacted
		expect(run.record.terminalError?.message).not.toContain("secret");
		expect(run.record.terminalError?.message).not.toContain("abc123");

		// The canonical Foundation receipt is the only persisted terminal source.
		const persisted = JSON.stringify(session.getEntries());
		expect(persisted).not.toContain("secret@mcp");
		expect(persisted).not.toContain("abc123");
		expect(ledgerKinds(session)).toEqual(["accepted", "started"]);
	});

	it("rejects a hand-written transport terminal instead of replaying its unredacted error", async () => {
		const session = makeSession();
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: { id: "r-raw", sessionId: session.getSessionId(), attempt: 1, status: "accepted", model: MODEL },
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
		expect(result?.receipt).toBeUndefined();
		expect(result?.record.terminalError).toBeUndefined();
		expect(result?.recovery).toBe("interrupted");
		expect(coordinator.diagnostics().some((diagnostic) => diagnostic.kind === "malformed")).toBe(true);
	});
});

// ---- Public-safe serialization --------------------------------------------------

// P0 public-identity markers from the hardening PR: fixed, searchable values that
// must never survive a public-safe serializer, whether as raw source, a path, or
// a URL credential/query.
const PATH_MARKER_WIN = "C:\\audit-private\\capability-source";
const PATH_MARKER_POSIX = "/audit-private/capability-source";
const URL_USERINFO_MARKER = "audit-user:audit-secret";
const URL_QUERY_MARKER = "token=audit-query-secret";

/** 43-char base64url token matching the installation identity's fixed-width HMAC output. */
const OPAQUE_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const OPAQUE_BINDING_ID = `binding:${OPAQUE_TOKEN}`;
const OPAQUE_REVISION = `rev:${OPAQUE_TOKEN}`;
const OPAQUE_DESCRIPTOR_ID = `builtin_tool:source:${OPAQUE_TOKEN}:Read`;

/**
 * Assert a value's JSON.stringify output is free of path and URL credential
 * markers. Windows paths are backslash-escaped inside JSON, so the distinctive
 * path fragments are matched rather than the literal single-backslash marker.
 */
function expectNoPublicMarkers(value: unknown): void {
	const json = JSON.stringify(value) ?? "undefined";
	expect(json).not.toContain(PATH_MARKER_POSIX);
	expect(json).not.toContain(URL_USERINFO_MARKER);
	expect(json).not.toContain(URL_QUERY_MARKER);
	expect(json).not.toContain("audit-private");
	expect(json).not.toContain("capability-source");
}

/** Sanity check that a legacy fixture really embeds all four markers. */
function expectRawLedgerCarriesMarkers(value: unknown): void {
	const json = JSON.stringify(value) ?? "";
	expect(json).toContain("audit-private");
	expect(json).toContain("capability-source");
	expect(json).toContain(URL_USERINFO_MARKER);
	expect(json).toContain(URL_QUERY_MARKER);
}

/** A legacy capability.binding ledger record whose ids embed raw source text. */
const LEGACY_BINDING: CapabilityBindingLedgerRecord = {
	id: `binding:default:${URL_QUERY_MARKER}`,
	profile: "default",
	createdAt: "2026-08-10T12:00:00.000Z",
	descriptors: [
		{ id: `extension:${PATH_MARKER_POSIX}:LegacyCap`, revision: "rev:1", exposedToolName: "LegacyTool" },
		{
			id: `skill:${URL_USERINFO_MARKER}:LegacySkill`,
			revision: `rev:${PATH_MARKER_WIN}`,
			exposedToolName: "LegacySkillTool",
		},
	],
	decisionSummary: { allowed: 2, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["LegacyTool", "LegacySkillTool"],
};

/** A current-format opaque binding whose descriptor refs are all public-safe. */
const OPAQUE_BINDING: CapabilityBindingLedgerRecord = {
	id: OPAQUE_BINDING_ID,
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [{ id: OPAQUE_DESCRIPTOR_ID, revision: OPAQUE_REVISION, exposedToolName: "Read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read"],
};

/** An opaque binding that also carries a legacy descriptor ref carrying a path. */
const MIXED_BINDING: CapabilityBindingLedgerRecord = {
	id: OPAQUE_BINDING_ID,
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [
		{ id: OPAQUE_DESCRIPTOR_ID, revision: OPAQUE_REVISION, exposedToolName: "Read" },
		{ id: `extension:${PATH_MARKER_POSIX}:LegacyCap`, revision: "rev:1", exposedToolName: "LegacyTool" },
	],
	decisionSummary: { allowed: 2, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read", "LegacyTool"],
};

function legacyRecord(sessionId: string): RunRecord {
	return {
		id: "r-legacy",
		sessionId,
		sourceRunId: "r-source",
		previousBindingId: LEGACY_BINDING.id,
		capabilityBindingId: LEGACY_BINDING.id,
		attempt: 2,
		status: "completed",
		model: MODEL,
	};
}

function minimalReceipt(sessionId: string, runId = "r-legacy"): PublicRunReceipt {
	return {
		runId,
		sessionId,
		runReceiptId: `run-receipt-${runId}`,
		taskResultId: `task-result-${runId}`,
		attemptReceiptIds: [`attempt-receipt-${runId}`],
		sideEffectState: "none",
		status: "completed",
		usage: { input: 1, output: 1, total: 2 },
	};
}

describe("opaque capability identity predicates", () => {
	it("validates current-format opaque binding ids", async () => {
		expect(OPAQUE_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(isOpaqueCapabilityBindingId(OPAQUE_BINDING_ID)).toBe(true);
		expect(isOpaqueCapabilityBindingId(`binding:${OPAQUE_TOKEN.slice(0, 42)}`)).toBe(false);
		expect(isOpaqueCapabilityBindingId("binding:default:abc123")).toBe(false);
		expect(isOpaqueCapabilityBindingId(LEGACY_BINDING.id)).toBe(false);
		expect(isOpaqueCapabilityBindingId(undefined)).toBe(false);
		expect(isOpaqueCapabilityBindingId(42)).toBe(false);
	});

	it("validates current-format opaque revisions", async () => {
		expect(isOpaqueCapabilityRevision(OPAQUE_REVISION)).toBe(true);
		expect(isOpaqueCapabilityRevision("rev:1")).toBe(false);
		expect(isOpaqueCapabilityRevision("rev:1a2b3c4d5e6f7a8b")).toBe(false);
		expect(isOpaqueCapabilityRevision(`rev:${URL_QUERY_MARKER}`)).toBe(false);
	});

	it("validates current-format opaque descriptor ids", async () => {
		expect(isOpaqueCapabilityDescriptorId(OPAQUE_DESCRIPTOR_ID)).toBe(true);
		expect(isOpaqueCapabilityDescriptorId("builtin_tool:core:read")).toBe(false);
		expect(isOpaqueCapabilityDescriptorId(`extension:${PATH_MARKER_POSIX}:LegacyCap`)).toBe(false);
		expect(isOpaqueCapabilityDescriptorId(`skill:${URL_USERINFO_MARKER}:LegacySkill`)).toBe(false);
		expect(isOpaqueCapabilityDescriptorId(`mcp_tool:source:${OPAQUE_TOKEN}:a:b`)).toBe(true);
	});
});

describe("public-safe capability binding serialization", () => {
	it("returns undefined for a legacy binding record and never echoes source text", async () => {
		expectRawLedgerCarriesMarkers(LEGACY_BINDING);

		expect(serializePublicCapabilityBinding(LEGACY_BINDING)).toBeUndefined();
		expectNoPublicMarkers(serializePublicCapabilityBinding(LEGACY_BINDING));
	});

	it("preserves a current-format opaque binding through the public serializer", async () => {
		const publicBinding = serializePublicCapabilityBinding(OPAQUE_BINDING);
		expect(publicBinding).toEqual(OPAQUE_BINDING);
		expectNoPublicMarkers(publicBinding);
	});

	it("omits legacy descriptor refs from an otherwise opaque binding", async () => {
		const publicBinding = serializePublicCapabilityBinding(MIXED_BINDING);
		expect(publicBinding).toBeDefined();
		expect(publicBinding?.id).toBe(OPAQUE_BINDING_ID);
		expect(publicBinding?.descriptors).toEqual([
			{ id: OPAQUE_DESCRIPTOR_ID, revision: OPAQUE_REVISION, exposedToolName: "Read" },
		]);
		expectNoPublicMarkers(publicBinding);
	});
});

describe("public-safe run record serialization", () => {
	it("omits a legacy previousBindingId but keeps the rest of the record", async () => {
		const record = legacyRecord("s-legacy");
		const publicRecord = serializePublicRunRecord(record);
		expect(publicRecord.previousBindingId).toBeUndefined();
		expect(publicRecord.capabilityBindingId).toBeUndefined();
		expect(publicRecord.id).toBe("r-legacy");
		expect(publicRecord.sessionId).toBe("s-legacy");
		expect(publicRecord.sourceRunId).toBe("r-source");
		expect(publicRecord.attempt).toBe(2);
		expect(publicRecord.status).toBe("completed");
		expect(publicRecord.model).toEqual(MODEL);
		expectNoPublicMarkers(publicRecord);
	});

	it("preserves a current-format opaque previousBindingId", async () => {
		const publicRecord = serializePublicRunRecord({
			id: "r-opaque",
			sessionId: "s-opaque",
			sourceRunId: "r-source",
			previousBindingId: OPAQUE_BINDING_ID,
			capabilityBindingId: OPAQUE_BINDING_ID,
			attempt: 1,
			status: "running",
			model: MODEL,
		});
		expect(publicRecord.previousBindingId).toBe(OPAQUE_BINDING_ID);
		expect(publicRecord.capabilityBindingId).toBe(OPAQUE_BINDING_ID);
		expectNoPublicMarkers(publicRecord);
	});

	it("replaces a terminal error with a fixed public-safe message", async () => {
		const publicRecord = serializePublicRunRecord({
			id: "r-err",
			sessionId: "s-err",
			attempt: 1,
			status: "failed",
			model: MODEL,
			terminalError: createAutomationError(
				"model_error",
				`${PATH_MARKER_WIN} / ${PATH_MARKER_POSIX} / https://${URL_USERINFO_MARKER}@host.invalid/pkg?${URL_QUERY_MARKER}`,
				false,
			),
		});
		expect(publicRecord.terminalError).toEqual({ code: "model_error", message: "Run failed.", retryable: false });
		expectNoPublicMarkers(publicRecord);
	});
});

describe("public-safe run receipt serialization", () => {
	it("preserves exactly the minimal canonical receipt", async () => {
		const receipt = minimalReceipt("s-canonical");
		const publicReceipt = serializePublicRunReceipt(receipt);
		expect(publicReceipt).toEqual(receipt);
		expect("capabilityBindingId" in publicReceipt).toBe(false);
		expect("sessionFile" in publicReceipt).toBe(false);
		expect(publicReceipt.runId).toBe("r-legacy");
		expect(publicReceipt.sessionId).toBe("s-canonical");
		expect(publicReceipt.status).toBe("completed");
		expect(publicReceipt.usage).toEqual({ input: 1, output: 1, total: 2 });
		expectNoPublicMarkers(publicReceipt);
	});
});

describe("public-safe session ledger serialization", () => {
	it("preserves search policy resources in run and policy ledger public records while rejecting unknown resources", async () => {
		const session = makeSession();
		const basePolicySummary = {
			bindingId: "policy-binding:search",
			profileId: "host-safe",
			profileRevision: "rev-search",
			projectTrust: "trusted",
			enforcement: "host",
			sandboxStatus: "not_required",
			sandboxCapabilities: { filesystem: false, process: false, network: false, credentialIsolation: false },
			action: "allow",
			outcome: "allow",
			timestamp: "2026-08-13T00:00:00.000Z",
		} as const;
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: "r-search-find",
				sessionId: session.getSessionId(),
				attempt: 1,
				status: "accepted",
				model: MODEL,
				policySummary: { ...basePolicySummary, resource: "filesystem.find" },
			},
		});
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: "r-search-grep",
				sessionId: session.getSessionId(),
				attempt: 1,
				status: "accepted",
				model: MODEL,
				policySummary: { ...basePolicySummary, resource: "filesystem.grep" },
			},
		});
		session.appendCustomEntry(POLICY_DECISION_CUSTOM_TYPE, {
			schemaVersion: 1,
			sequence: 1,
			record: { ...basePolicySummary, bindingId: "policy-binding:find", resource: "filesystem.find" },
		});
		session.appendCustomEntry(POLICY_DECISION_CUSTOM_TYPE, {
			schemaVersion: 1,
			sequence: 2,
			record: { ...basePolicySummary, bindingId: "policy-binding:grep", resource: "filesystem.grep" },
		});
		session.appendCustomEntry(POLICY_DECISION_CUSTOM_TYPE, {
			schemaVersion: 1,
			sequence: 3,
			record: { ...basePolicySummary, bindingId: "policy-binding:unknown", resource: "filesystem.search" },
		});

		const coordinator = makeCoordinator(session);
		expect(coordinator.getRun("r-search-find")?.record.policySummary?.resource).toBe("filesystem.find");
		expect(coordinator.getRun("r-search-grep")?.record.policySummary?.resource).toBe("filesystem.grep");

		const publicEntries = session.getEntries().map((entry) => serializePublicSessionEntry(entry));
		const publicRunRecords = publicEntries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE ? [entry.data] : [],
		);
		expect(JSON.stringify(publicRunRecords)).toContain("filesystem.find");
		expect(JSON.stringify(publicRunRecords)).toContain("filesystem.grep");

		const publicDecisionResources = publicEntries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === POLICY_DECISION_CUSTOM_TYPE
				? [(entry.data as { summary?: { resource?: string } } | undefined)?.summary?.resource]
				: [],
		);
		expect(publicDecisionResources).toEqual(["filesystem.find", "filesystem.grep", undefined]);
	});

	it("keeps legacy capability and unknown custom facts internal at public boundaries", async () => {
		const session = makeSession();
		session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, { schemaVersion: 1, binding: LEGACY_BINDING });
		session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "accepted",
			record: legacyRecord(session.getSessionId()),
		});
		session.appendCustomEntry("extension.private", {
			path: PATH_MARKER_WIN,
			url: `https://${URL_USERINFO_MARKER}@host.invalid/pkg?${URL_QUERY_MARKER}`,
		});

		const entries = session.getEntries();
		const publicEntries = entries.map((entry) => serializePublicSessionEntry(entry));
		const publicTree = session.getTree().map((node) => serializePublicSessionTreeNode(node));

		expectNoPublicMarkers(publicEntries);
		expectNoPublicMarkers(publicTree);
		const publicBinding = publicEntries.find(
			(entry) => entry.type === "custom" && entry.customType === CAPABILITY_BINDING_CUSTOM_TYPE,
		);
		expect(publicBinding).toMatchObject({ type: "custom", customType: CAPABILITY_BINDING_CUSTOM_TYPE });
		if (publicBinding?.type !== "custom") throw new Error("expected public capability binding entry");
		expect(publicBinding.data).toBeUndefined();

		const privateEntry = publicEntries.find(
			(entry) => entry.type === "custom" && entry.customType === "extension.private",
		);
		expect(privateEntry).toMatchObject({ type: "custom", customType: "extension.private" });
		if (privateEntry?.type !== "custom") throw new Error("expected extension custom entry");
		expect(privateEntry.data).toBeUndefined();
	});

	it("preserves current opaque ledger references and serializes terminal stream receipts", async () => {
		const record: RunRecord = {
			id: "r-opaque",
			sessionId: "s-opaque",
			previousBindingId: OPAQUE_BINDING_ID,
			capabilityBindingId: OPAQUE_BINDING_ID,
			attempt: 1,
			status: "accepted",
			model: MODEL,
		};
		const receipt = minimalReceipt("s-opaque", "r-opaque");
		const publicAccepted = serializePublicSessionEntry({
			type: "custom",
			id: "accepted-entry",
			parentId: null,
			timestamp: "2026-08-10T12:00:00.000Z",
			customType: RUN_LEDGER_CUSTOM_TYPE,
			data: { schemaVersion: 1, kind: "accepted", record },
		});
		const publicTerminal = serializePublicRunStreamEvent({
			type: "run.completed",
			eventId: "event-r-opaque",
			streamId: "stream-r-opaque",
			correlation: { sessionId: "s-opaque", runId: "r-opaque" },
			runId: "r-opaque",
			sessionId: "s-opaque",
			sequence: 1,
			timestamp: "2026-08-10T12:00:01.000Z",
			receipt,
		});

		expectNoPublicMarkers(publicAccepted);
		expectNoPublicMarkers(publicTerminal);
		const acceptedRecord =
			publicAccepted.type === "custom"
				? (
						publicAccepted.data as
							| { record?: { previousBindingId?: string; capabilityBindingId?: string } }
							| undefined
					)?.record
				: undefined;
		expect(acceptedRecord?.previousBindingId).toBe(OPAQUE_BINDING_ID);
		expect(acceptedRecord?.capabilityBindingId).toBe(OPAQUE_BINDING_ID);
		if (!("receipt" in publicTerminal)) throw new Error("expected terminal public run event");
		expect("capabilityBindingId" in publicTerminal.receipt).toBe(false);
		expect("sessionFile" in publicTerminal.receipt).toBe(false);
	});
});

describe("public-safe serializers preserve internal replay semantics", () => {
	it("keeps legacy raw binding ids on internal records while public output omits them", async () => {
		expectRawLedgerCarriesMarkers(LEGACY_BINDING);

		const internalRecord = legacyRecord("session-legacy-record");
		expect(internalRecord.previousBindingId).toBe(LEGACY_BINDING.id);
		const publicRecord = serializePublicRunRecord(internalRecord);
		const publicReceipt = serializePublicRunReceipt(minimalReceipt("session-legacy-record"));
		expect(serializePublicCapabilityBinding(LEGACY_BINDING)).toBeUndefined();
		expect(publicRecord.previousBindingId).toBeUndefined();
		expect(publicRecord.capabilityBindingId).toBeUndefined();
		expect("capabilityBindingId" in publicReceipt).toBe(false);
		expectNoPublicMarkers(publicRecord);
		expectNoPublicMarkers(publicReceipt);
	});
});
