import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { appendPolicyApprovalEntry, POLICY_APPROVAL_CUSTOM_TYPE } from "../src/core/execution-policy-ledger.ts";
import type { PolicyApprovalRequest } from "../src/core/execution-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../src/modes/rpc/rpc-host.ts";
import type {
	GetExecutionPolicyData,
	RpcAutomationResponse,
	RpcMcpAuthResponse,
	RpcMcpContentResponse,
	RpcCommand,
	RpcResponse,
	TaskGateRecord,
} from "../src/modes/rpc/rpc-types.ts";

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

// agent-session.ts statically imports values from @aos-agent/ai/compat, whose
// entrypoint pulls in a generated catalog that is not required by this harness.
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
		throw new Error("streamSimple is not exercised by the local mock-stream harness");
	},
}));

// loader.ts holds @aos-agent/ai/providers/all only as a virtual-module namespace
// for bundling; an empty mock avoids loading provider factories.
vi.mock("@aos-agent/ai/providers/all", () => ({}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const DEFAULT_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

/** Minimal ResourceLoader with no extension or generated-catalog side effects. */
function testResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getContextSources: () => ({ contextSources: [] }),
		toContextSourceInputs: () => [],
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

const tempDirs: string[] = [];
async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	sessionPath?: string;
}): Promise<{ runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
	const tempDir = join(tmpdir(), `aos-rpc-task-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: DEFAULT_MODEL,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const modelRuntime = {
		hasConfiguredAuth: () => options.withAuth,
		checkAuth: async () => (options.withAuth ? { type: "api_key", key: "test-key" } : undefined),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "test-key" }),
	} as unknown as ModelRuntime;
	const resourceLoader = testResourceLoader();
	const openSession = (sessionManager: SessionManager): AgentSession =>
		new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
		});

	// Session persistence only flushes to disk on the first assistant message.
	// Seed a user/assistant pair so the session file exists even though gate tests
	// never start a Run.
	const createSeededSession = (dir: string): AgentSession => {
		const sessionManager = SessionManager.create(dir, dir);
		sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed reply" }],
			api: "anthropic-messages",
			provider: "test",
			model: "test-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop" as const,
			timestamp: 2,
		});
		return openSession(sessionManager);
	};

	let currentSession =
		options.sessionPath === undefined ? createSeededSession(tempDir) : openSession(SessionManager.open(options.sessionPath));
	let rebindCallback: (() => Promise<void>) | undefined;

	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setRebindSession: vi.fn((cb?: (() => Promise<void>) | undefined) => {
			rebindCallback = cb;
		}),
		switchSession: vi.fn(async (sessionPath: string) => {
			// Simulate a real session switch: open the persisted ledger, rebuild the
			// session, and re-run the registered rebind so the controller rebuilds
			// its coordinator and TaskGateStore against the restored session.
			currentSession = openSession(SessionManager.open(sessionPath));
			if (rebindCallback !== undefined) {
				await rebindCallback();
			}
			return { cancelled: false };
		}),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (currentSession.isStreaming) await currentSession.abort();
			} catch {
				// ignore test cleanup failures
			}
			currentSession.dispose();
		},
	};
}

async function startInMemoryController(options: {
	withAuth: boolean;
	responseDelayMs: number;
	sessionPath?: string;
}): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	records: RpcHostOutputRecord[];
	cleanup: () => Promise<void>;
}> {
	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, {
		output: { publish: (record) => records.push(record) } satisfies RpcHostOutputSink,
	});
	await controller.start();
	return { controller, runtimeHost, records, cleanup };
}

function automationRecords(records: readonly RpcHostOutputRecord[]): RpcAutomationResponse[] {
	return records.filter(
		(record): record is RpcAutomationResponse => record.type === "response" && "error" in record,
	);
}

function dispatchCommand(
	controller: RpcHostController,
	command: RpcCommand,
): Promise<RpcResponse | RpcAutomationResponse | RpcMcpAuthResponse | RpcMcpContentResponse | undefined> {
	return controller.dispatch(command);
}

function gateEntries(session: AgentSession): Array<{ id: string; data: unknown }> {
	return session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "task.gate")
		.map((entry) => ({
			id: entry.id,
			data: (entry as { data?: unknown }).data,
		}));
}

function expectAutomationError(
	response: RpcResponse | RpcAutomationResponse | RpcMcpAuthResponse | RpcMcpContentResponse | undefined,
	command: string,
	code: string,
): void {
	expect(response).toBeDefined();
	const record = response as { type: string; command: string; success: boolean; error: { code: string; retryable: boolean; message: string } };
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(false);
	expect(record.error.code).toBe(code);
	expect(record.error.retryable).toBe(false);
	expect(typeof record.error.message).toBe("string");
	expect(record.error.message.length).toBeGreaterThan(0);
}

const PENDING_POLICY_ASK: PolicyApprovalRequest = {
	id: "policy-request:pending-ask",
	bindingId: "policy-binding-1",
	resource: "process.spawn",
	source: "user_bash",
	scope: { resource: "process.spawn" },
	reasonCode: "policy_approval_required",
	reason: "Policy approval is required before this operation.",
	createdAt: "2026-08-15T12:00:00.000Z",
};

function seedPendingPolicyAsk(session: AgentSession, approval: PolicyApprovalRequest = PENDING_POLICY_ASK): void {
	appendPolicyApprovalEntry(session.sessionManager, approval);
	const internals = session as unknown as {
		_pendingExecutionPolicyApprovals: Map<string, PolicyApprovalRequest>;
	};
	internals._pendingExecutionPolicyApprovals.set(approval.id, approval);
}

function policyApprovalEntries(session: AgentSession): unknown[] {
	return session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === POLICY_APPROVAL_CUSTOM_TYPE)
		.map((entry) => (entry as { data?: unknown }).data);
}

function expectGateResponse(
	response: RpcResponse | RpcAutomationResponse | RpcMcpAuthResponse | RpcMcpContentResponse | undefined,
	command: string,
): { gate: TaskGateRecord; idempotent: boolean } {
	expect(response).toBeDefined();
	const record = response as { type: string; command: string; success: boolean; data: { gate: TaskGateRecord; idempotent: boolean } };
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(true);
	const data = record.data;
	expect(data.gate.schemaVersion).toBe(1);
	expect(typeof data.gate.gateId).toBe("string");
	return data;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("task gate automation host rpc", () => {
	it("initialize advertises the six taskGateCommands while keeping protocolVersion 1", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			const response = (await dispatchCommand(controller, {
				id: "init-1",
				type: "initialize",
				protocolVersion: 1,
			})) as { type: string; command: string; success: boolean; data: {
				host: string;
				protocolVersion: number;
				sessionId: string;
				runCommands: string[];
				auditCommands: string[];
				taskGateCommands: string[];
			} };
			expect(response).toMatchObject({
				type: "response",
				command: "initialize",
				success: true,
			});
			const data = response.data;
			expect(data.host).toBe("automation-host");
			expect(data.protocolVersion).toBe(1);
			expect(typeof data.sessionId).toBe("string");
			expect(data.runCommands).toEqual(["run.start", "run.get", "run.cancel", "run.resume"]);
			expect(data.auditCommands).toEqual(["audit.query", "audit.replay", "external.map"]);
			expect(data.taskGateCommands).toEqual([
				"task.gate.request",
				"task.gate.get",
				"task.gate.list",
				"task.gate.approve",
				"task.gate.reject",
				"task.gate.cancel",
			]);
		} finally {
			await cleanup();
		}
	});

	it("rejects every task.gate command before initialize with host_not_initialized", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			for (const command of [
				{ id: "r1", type: "task.gate.request", taskId: "task_1", stageId: "stage_1", stageRevision: 1, clientRequestId: "c1" },
				{ id: "g1", type: "task.gate.get", gateId: "gate_001" },
				{ id: "l1", type: "task.gate.list" },
				{ id: "a1", type: "task.gate.approve", gateId: "gate_001", clientRequestId: "c2" },
				{ id: "j1", type: "task.gate.reject", gateId: "gate_001", clientRequestId: "c3" },
				{ id: "x1", type: "task.gate.cancel", gateId: "gate_001", clientRequestId: "c4" },
			] as RpcCommand[]) {
				const response = await dispatchCommand(controller, command);
				expectAutomationError(response, command.type, "host_not_initialized");
			}
		} finally {
			await cleanup();
		}
	});

	it("request creates a pending gate, persists one task.gate custom entry, and never touches runs", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const response = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				runId: "run_abc123",
				clientRequestId: "gate-request-001",
			});
			const data = expectGateResponse(response, "task.gate.request");
			expect(data.idempotent).toBe(false);
			expect(data.gate).toMatchObject({
				sessionId: runtimeHost.session.sessionId,
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				status: "pending",
				revision: 0,
				runId: "run_abc123",
			});
			expect(data.gate.decidedAt).toBeUndefined();
			expect(data.gate.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

			const entries = gateEntries(runtimeHost.session);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.data).toMatchObject({
				schemaVersion: 1,
				action: "requested",
				previousRevision: 0,
				clientRequestId: "gate-request-001",
			});

			// Gate commands are control-plane only: no run records and no legacy
			// session events are emitted for the transition.
			expect(records.some((record) => record.type.startsWith("run."))).toBe(false);
			expect(automationRecords(records)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("request rejects duplicate business keys, unsafe ids, bad revisions, and missing clientRequestId", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const gateId = expectGateResponse(first, "task.gate.request").gate.gateId;

			// Same business key with a different clientRequestId conflicts.
			const duplicate = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-002",
			});
			expectAutomationError(duplicate, "task.gate.request", "task_gate_conflict");

			// A higher stageRevision creates a fresh gate.
			const nextRevision = await dispatchCommand(controller, {
				id: "req-3",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 4,
				clientRequestId: "gate-request-003",
			});
			expect(expectGateResponse(nextRevision, "task.gate.request").gate.stageRevision).toBe(4);

			// stageRevision must be a positive safe integer.
			for (const stageRevision of [0, -1, 1.5]) {
				const invalid = await dispatchCommand(
					controller,
					{ id: "req-bad", type: "task.gate.request", taskId: "task_42", stageId: "stage_review", stageRevision, clientRequestId: "bad-1" } as RpcCommand,
				);
				expectAutomationError(invalid, "task.gate.request", "task_gate_invalid");
			}

			// Unsafe opaque identifiers (paths / URLs / controls) are rejected.
			for (const taskId of ["../etc/passwd", "https://host.invalid/x", "task\n42"]) {
				const invalid = await dispatchCommand(
					controller,
					{ id: "req-bad", type: "task.gate.request", taskId, stageId: "stage_review", stageRevision: 1, clientRequestId: "bad-2" } as RpcCommand,
				);
				expectAutomationError(invalid, "task.gate.request", "task_gate_invalid");
			}

			// All writes require clientRequestId.
			const missingKey = await dispatchCommand(
				controller,
				{ id: "req-bad", type: "task.gate.request", taskId: "task_9", stageId: "stage_9", stageRevision: 1 } as RpcCommand,
			);
			expectAutomationError(missingKey, "task.gate.request", "task_gate_invalid");

			// Forbidden payload keys are rejected at the command boundary and never persist.
			const forbidden = await dispatchCommand(
				controller,
				{ id: "req-forbidden", type: "task.gate.request", taskId: "task_9", stageId: "stage_9", stageRevision: 1, clientRequestId: "bad-3", prompt: "secret text" } as RpcCommand,
			);
			expectAutomationError(forbidden, "task.gate.request", "task_gate_invalid");
			const forbiddenJson = JSON.stringify(forbidden);
			expect(forbiddenJson).not.toContain("secret text");
			expect(forbiddenJson).not.toContain("prompt");

			// Only the two successful requests were written. Rejected requests
			// never appended a transition, and no raw payload leaked into the ledger.
			const entries = gateEntries(runtimeHost.session);
			expect(entries).toHaveLength(2);
			expect(JSON.stringify(entries)).not.toContain("secret text");
			expect(JSON.stringify(entries)).not.toContain("prompt");
			expect(gateId.length).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it("get returns the gate and stays read-only; unknown gates fail with task_gate_not_found", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;

			const entriesBefore = gateEntries(runtimeHost.session).length;
			const get = await dispatchCommand(controller, { id: "get-1", type: "task.gate.get", gateId });
			const data = expectGateResponse(get, "task.gate.get");
			expect(data.gate.gateId).toBe(gateId);
			expect(data.gate.status).toBe("pending");

			const missing = await dispatchCommand(controller, { id: "get-2", type: "task.gate.get", gateId: "gate_unknown" });
			expectAutomationError(missing, "task.gate.get", "task_gate_not_found");

			// Reads never append transitions.
			expect(gateEntries(runtimeHost.session).length).toBe(entriesBefore);
		} finally {
			await cleanup();
		}
	});

	it("list filters by taskId/stageId/status and enforces the server limit", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			for (let index = 0; index < 60; index += 1) {
				await dispatchCommand(controller, {
					id: `req-${index}`,
					type: "task.gate.request",
					taskId: index % 2 === 0 ? "task_even" : "task_odd",
					stageId: "stage_1",
					stageRevision: index + 1,
					clientRequestId: `req-${index}`,
				});
			}

			// Default limit is 50 with truncation; no cross-session cursor exists.
			const defaultList = await dispatchCommand(controller, { id: "list-1", type: "task.gate.list" });
			const defaultData = (defaultList as { data: { gates: TaskGateRecord[]; truncated: boolean } }).data;
			expect(defaultData.gates).toHaveLength(50);
			expect(defaultData.truncated).toBe(true);

			// Explicit limit up to 100.
			const explicit = await dispatchCommand(controller, { id: "list-2", type: "task.gate.list", limit: 100 });
			const explicitData = (explicit as { data: { gates: TaskGateRecord[]; truncated: boolean } }).data;
			expect(explicitData.gates).toHaveLength(60);
			expect(explicitData.truncated).toBe(false);

			// Filters are exact matches.
			const filtered = await dispatchCommand(controller, {
				id: "list-3",
				type: "task.gate.list",
				taskId: "task_even",
				status: "pending",
				limit: 100,
			});
			const filteredData = (filtered as { data: { gates: TaskGateRecord[]; truncated: boolean } }).data;
			expect(filteredData.gates).toHaveLength(30);
			expect(filteredData.truncated).toBe(false);
			expect(filteredData.gates.every((gate) => gate.taskId === "task_even" && gate.status === "pending")).toBe(true);

			// Limits above the server maximum are invalid.
			const overLimit = await dispatchCommand(
				controller,
				{ id: "list-4", type: "task.gate.list", limit: 101 } as RpcCommand,
			);
			expectAutomationError(overLimit, "task.gate.list", "task_gate_invalid");

			// Unsafe filter identifiers are invalid.
			const unsafeFilter = await dispatchCommand(
				controller,
				{ id: "list-5", type: "task.gate.list", taskId: "../etc" } as RpcCommand,
			);
			expectAutomationError(unsafeFilter, "task.gate.list", "task_gate_invalid");
		} finally {
			await cleanup();
		}
	});

	it("approve, reject, and cancel each move a pending gate to its terminal state", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });

			const approved = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_a",
				stageId: "stage_a",
				stageRevision: 1,
				clientRequestId: "req-1",
			});
			const approvedGateId = expectGateResponse(approved, "task.gate.request").gate.gateId;
			const approve = await dispatchCommand(controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId: approvedGateId,
				actorId: "operator_7",
				clientRequestId: "approve-1",
			});
			const approveData = expectGateResponse(approve, "task.gate.approve");
			expect(approveData.idempotent).toBe(false);
			expect(approveData.gate).toMatchObject({ gateId: approvedGateId, status: "approved", revision: 1, actorId: "operator_7" });
			expect(approveData.gate.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

			const rejected = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_b",
				stageId: "stage_b",
				stageRevision: 1,
				clientRequestId: "req-2",
			});
			const rejectedGateId = expectGateResponse(rejected, "task.gate.request").gate.gateId;
			const reject = await dispatchCommand(controller, {
				id: "rj-1",
				type: "task.gate.reject",
				gateId: rejectedGateId,
				actorId: "operator_7",
				reasonCode: "quality_check_failed",
				clientRequestId: "reject-1",
			});
			const rejectData = expectGateResponse(reject, "task.gate.reject");
			expect(rejectData.gate).toMatchObject({
				gateId: rejectedGateId,
				status: "rejected",
				revision: 1,
				reasonCode: "quality_check_failed",
			});

			const cancelled = await dispatchCommand(controller, {
				id: "req-3",
				type: "task.gate.request",
				taskId: "task_c",
				stageId: "stage_c",
				stageRevision: 1,
				clientRequestId: "req-3",
			});
			const cancelledGateId = expectGateResponse(cancelled, "task.gate.request").gate.gateId;
			const cancel = await dispatchCommand(controller, {
				id: "cx-1",
				type: "task.gate.cancel",
				gateId: cancelledGateId,
				actorId: "operator_7",
				clientRequestId: "cancel-1",
			});
			const cancelData = expectGateResponse(cancel, "task.gate.cancel");
			expect(cancelData.gate).toMatchObject({ gateId: cancelledGateId, status: "cancelled", revision: 1 });

			// Each decision appends exactly one durable transition.
			expect(gateEntries(runtimeHost.session)).toHaveLength(6);
		} finally {
			await cleanup();
		}
	});

	it("approve never accepts a reasonCode", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_a",
				stageId: "stage_a",
				stageRevision: 1,
				clientRequestId: "req-1",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;
			const approve = await dispatchCommand(controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId,
				reasonCode: "quality_check_failed",
				clientRequestId: "approve-1",
			} as RpcCommand);
			expectAutomationError(approve, "task.gate.approve", "task_gate_invalid");
		} finally {
			await cleanup();
		}
	});

	it("replays identical write commands idempotently without a second transition", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const first = expectGateResponse(request, "task.gate.request");
			const replay = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const replayed = expectGateResponse(replay, "task.gate.request");
			expect(replayed.idempotent).toBe(true);
			expect(replayed.gate.gateId).toBe(first.gate.gateId);
			expect(gateEntries(runtimeHost.session)).toHaveLength(1);

			const approve = await dispatchCommand(controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId: first.gate.gateId,
				actorId: "operator_7",
				clientRequestId: "approve-1",
			});
			const approved = expectGateResponse(approve, "task.gate.approve");
			expect(approved.gate.status).toBe("approved");
			const approveReplay = await dispatchCommand(controller, {
				id: "ap-2",
				type: "task.gate.approve",
				gateId: first.gate.gateId,
				actorId: "operator_7",
				clientRequestId: "approve-1",
			});
			const replayedApprove = expectGateResponse(approveReplay, "task.gate.approve");
			expect(replayedApprove.idempotent).toBe(true);
			expect(replayedApprove.gate.status).toBe("approved");
			expect(gateEntries(runtimeHost.session)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("rejects a reused clientRequestId with a different payload", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			expectGateResponse(first, "task.gate.request");
			const conflict = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_43",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			expectAutomationError(conflict, "task.gate.request", "task_gate_idempotency_conflict");
			expect(gateEntries(runtimeHost.session)).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("never overwrites a terminal gate with an opposite decision", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;
			const approve = await dispatchCommand(controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "approve-1",
			});
			expect(expectGateResponse(approve, "task.gate.approve").gate.status).toBe("approved");

			// Opposite decision conflicts and the persisted terminal is untouched.
			const reject = await dispatchCommand(controller, {
				id: "rj-1",
				type: "task.gate.reject",
				gateId,
				actorId: "operator_7",
				clientRequestId: "reject-1",
			});
			expectAutomationError(reject, "task.gate.reject", "task_gate_conflict");

			// The same decision on a terminal gate reports not_pending.
			const approveAgain = await dispatchCommand(controller, {
				id: "ap-2",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "approve-2",
			});
			expectAutomationError(approveAgain, "task.gate.approve", "task_gate_not_pending");

			// Unknown gates fail with not_found.
			const unknown = await dispatchCommand(controller, {
				id: "ap-3",
				type: "task.gate.approve",
				gateId: "gate_unknown",
				clientRequestId: "approve-3",
			});
			expectAutomationError(unknown, "task.gate.approve", "task_gate_not_found");

			const get = await dispatchCommand(controller, { id: "get-1", type: "task.gate.get", gateId });
			expect(expectGateResponse(get, "task.gate.get").gate.status).toBe("approved");
			expect(gateEntries(runtimeHost.session)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("keeps structured errors redacted: no payload, id, or raw text is echoed", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const response = await dispatchCommand(
				controller,
				{
					id: "req-1",
					type: "task.gate.request",
					taskId: "../../secret_path",
					stageId: "stage_secret",
					stageRevision: 1,
					clientRequestId: "secret-key-001",
				} as RpcCommand,
			);
			expectAutomationError(response, "task.gate.request", "task_gate_invalid");
			const json = JSON.stringify(response);
			expect(json).not.toContain("secret_path");
			expect(json).not.toContain("stage_secret");
			expect(json).not.toContain("secret-key-001");

			// A persisted failure is never guessed as success: an unknown gate
			// decision echoes only the stable error contract.
			const decision = await dispatchCommand(controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId: "gate_secret_unknown",
				clientRequestId: "approve-secret-1",
			});
			expectAutomationError(decision, "task.gate.approve", "task_gate_not_found");
			const decisionJson = JSON.stringify(decision);
			expect(decisionJson).not.toContain("gate_secret_unknown");
			expect(decisionJson).not.toContain("approve-secret-1");
		} finally {
			await cleanup();
		}
	});

	it("rebinds the gate store to the switched session without leaking gates", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_a",
				stageId: "stage_a",
				stageRevision: 1,
				clientRequestId: "req-1",
			});
			const firstGateId = expectGateResponse(first, "task.gate.request").gate.gateId;
			const firstSessionId = runtimeHost.session.sessionId;

			// Switch to a fresh session file: gates must not leak across sessions.
			const switchDir = join(
				tmpdir(),
				`aos-rpc-task-gate-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(switchDir, { recursive: true });
			const targetSession = SessionManager.create(switchDir, switchDir);
			targetSession.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			targetSession.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "seed reply" }],
				api: "anthropic-messages",
				provider: "test",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp: 2,
			});
			const targetPath = targetSession.getSessionFile();
			expect(targetPath).toBeDefined();
			const switched = await (runtimeHost.switchSession as unknown as (path: string) => Promise<{ cancelled: boolean }>)(targetPath!);
			expect(switched.cancelled).toBe(false);
			expect(runtimeHost.session.sessionId).not.toBe(firstSessionId);

			const missing = await dispatchCommand(controller, { id: "get-1", type: "task.gate.get", gateId: firstGateId });
			expectAutomationError(missing, "task.gate.get", "task_gate_not_found");

			// The new session has its own gate namespace and writes its own entries.
			const second = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_b",
				stageId: "stage_b",
				stageRevision: 1,
				clientRequestId: "req-2",
			});
			const secondData = expectGateResponse(second, "task.gate.request");
			expect(secondData.gate.sessionId).toBe(runtimeHost.session.sessionId);
			expect(secondData.gate.gateId).not.toBe(firstGateId);
			expect(gateEntries(runtimeHost.session)).toHaveLength(1);
			rmSync(switchDir, { recursive: true, force: true });
		} finally {
			await cleanup();
		}
	});

	it("recovers pending and terminal gates from the session file after a host restart", async () => {
		const first = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		let sessionPath: string | undefined;
		let gateId: string | undefined;
		let pendingGateId: string | undefined;
		try {
			await dispatchCommand(first.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const request = await dispatchCommand(first.controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			gateId = expectGateResponse(request, "task.gate.request").gate.gateId;
			const approve = await dispatchCommand(first.controller, {
				id: "ap-1",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "approve-1",
			});
			expect(expectGateResponse(approve, "task.gate.approve").gate.status).toBe("approved");
			const pending = await dispatchCommand(first.controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_43",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-request-002",
			});
			pendingGateId = expectGateResponse(pending, "task.gate.request").gate.gateId;
			sessionPath = first.runtimeHost.session.sessionFile;
			expect(sessionPath).toBeDefined();
			expect(sessionPath !== undefined && existsSync(sessionPath)).toBe(true);
		} finally {
			await first.cleanup();
		}

		// A fresh host over the same session file folds the transitions back.
		expect(sessionPath).toBeDefined();
		expect(gateId).toBeDefined();
		expect(pendingGateId).toBeDefined();
		const second = await startInMemoryController({ withAuth: true, responseDelayMs: 1, sessionPath });
		try {
			await dispatchCommand(second.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const approved = await dispatchCommand(second.controller, { id: "get-1", type: "task.gate.get", gateId: gateId! });
			const approvedData = expectGateResponse(approved, "task.gate.get");
			expect(approvedData.gate.status).toBe("approved");
			expect(approvedData.gate.revision).toBe(1);
			expect(approvedData.gate.actorId).toBe("operator_7");

			const pending = await dispatchCommand(second.controller, {
				id: "get-2",
				type: "task.gate.get",
				gateId: pendingGateId!,
			});
			const pendingData = expectGateResponse(pending, "task.gate.get");
			expect(pendingData.gate.status).toBe("pending");
			expect(pendingData.gate.revision).toBe(0);

			// The recovered store still applies the state machine to new decisions.
			const reject = await dispatchCommand(second.controller, {
				id: "rj-1",
				type: "task.gate.reject",
				gateId: pendingGateId!,
				actorId: "operator_7",
				reasonCode: "quality_check_failed",
				clientRequestId: "reject-1",
			});
			expect(expectGateResponse(reject, "task.gate.reject").gate.status).toBe("rejected");
		} finally {
			await second.cleanup();
		}
	});

	it("does not start a Run or emit run events when no Run exists", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
		});
		try {
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });

			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				runId: "run_correl",
				clientRequestId: "gate-request-001",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;

			const approve = await dispatchCommand(controller, {
				id: "app-1",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "gate-approve-001",
			});
			expect(expectGateResponse(approve, "task.gate.approve").gate.status).toBe("approved");

			// A correlated runId is not a Run fact: Gate approved never starts a Run.
			const runGet = await dispatchCommand(controller, { id: "run-get-1", type: "run.get", runId: "run_correl" });
			expectAutomationError(runGet, "run.get", "run_not_found");

			const rejectRequest = await dispatchCommand(controller, {
				id: "req-2",
				type: "task.gate.request",
				taskId: "task_43",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-request-002",
			});
			const rejectGateId = expectGateResponse(rejectRequest, "task.gate.request").gate.gateId;
			const reject = await dispatchCommand(controller, {
				id: "rj-1",
				type: "task.gate.reject",
				gateId: rejectGateId,
				reasonCode: "quality_check_failed",
				clientRequestId: "gate-reject-001",
			});
			expect(expectGateResponse(reject, "task.gate.reject").gate.status).toBe("rejected");

			const cancelRequest = await dispatchCommand(controller, {
				id: "req-3",
				type: "task.gate.request",
				taskId: "task_44",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-request-003",
			});
			const cancelGateId = expectGateResponse(cancelRequest, "task.gate.request").gate.gateId;
			const cancel = await dispatchCommand(controller, {
				id: "cn-1",
				type: "task.gate.cancel",
				gateId: cancelGateId,
				clientRequestId: "gate-cancel-001",
			});
			expect(expectGateResponse(cancel, "task.gate.cancel").gate.status).toBe("cancelled");

			expect(promptSpy).not.toHaveBeenCalled();
			expect(records.some((record) => record.type.startsWith("run."))).toBe(false);
			expect(records.some((record) => record.type === "run.started")).toBe(false);
			expect(records.some((record) => record.type === "run.failed" || record.type === "run.cancelled")).toBe(false);

			const customTypes = runtimeHost.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom")
				.map((entry) => (entry as { customType?: string }).customType);
			expect(customTypes).toEqual(["task.gate", "task.gate", "task.gate", "task.gate", "task.gate", "task.gate"]);
			expect(customTypes.some((type) => type?.startsWith("policy.") || type?.startsWith("automation.run"))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("does not satisfy or change a pending Policy ask", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			seedPendingPolicyAsk(runtimeHost.session);
			const approveSpy = vi.spyOn(runtimeHost.session, "approveExecutionPolicyRequest");
			const rejectSpy = vi.spyOn(runtimeHost.session, "rejectExecutionPolicyRequest");

			const before = await dispatchCommand(controller, { id: "pol-1", type: "get_execution_policy" });
			expect(before).toMatchObject({ type: "response", command: "get_execution_policy", success: true });
			const beforeData = (before as { data: GetExecutionPolicyData }).data;
			expect(beforeData.pendingApprovals.map((approval) => approval.id)).toEqual([PENDING_POLICY_ASK.id]);
			const policyBefore = JSON.stringify(policyApprovalEntries(runtimeHost.session));

			const request = await dispatchCommand(controller, {
				id: "req-1",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 3,
				clientRequestId: "gate-request-001",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;
			const approve = await dispatchCommand(controller, {
				id: "app-1",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "gate-approve-001",
			});
			expect(expectGateResponse(approve, "task.gate.approve").gate.status).toBe("approved");

			const after = await dispatchCommand(controller, { id: "pol-2", type: "get_execution_policy" });
			const afterData = (after as { data: GetExecutionPolicyData }).data;
			expect(afterData.pendingApprovals.map((approval) => approval.id)).toEqual([PENDING_POLICY_ASK.id]);
			expect(afterData.pendingApprovals[0]?.reasonCode).toBe("policy_approval_required");
			expect(JSON.stringify(policyApprovalEntries(runtimeHost.session))).toBe(policyBefore);
			expect(approveSpy).not.toHaveBeenCalled();
			expect(rejectSpy).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("does not change an existing Run receipt when a Gate is approved, rejected, or cancelled", async () => {
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 40,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });

			const start = dispatchCommand(controller, { id: "run-1", type: "run.start", message: "hello" });
			await vi.waitFor(() => expect(records.some((record) => record.type === "run.started")).toBe(true));
			const started = records.find((record) => record.type === "run.started") as { runId?: string };
			const runId = String(started.runId ?? "");
			expect(runId).not.toBe("");

			const during = await dispatchCommand(controller, {
				id: "req-live",
				type: "task.gate.request",
				taskId: "task_live",
				stageId: "stage_review",
				stageRevision: 1,
				runId,
				clientRequestId: "gate-live-001",
			});
			const liveGateId = expectGateResponse(during, "task.gate.request").gate.gateId;
			const rejectLive = await dispatchCommand(controller, {
				id: "rj-live",
				type: "task.gate.reject",
				gateId: liveGateId,
				reasonCode: "quality_check_failed",
				clientRequestId: "gate-live-reject",
			});
			expect(expectGateResponse(rejectLive, "task.gate.reject").gate.status).toBe("rejected");

			await start;
			await vi.waitFor(() =>
				expect(records.some((record) => record.type === "run.completed" || record.type === "run.failed")).toBe(
					true,
				),
			);

			const afterComplete = await dispatchCommand(controller, { id: "get-run-1", type: "run.get", runId });
			expect(afterComplete).toMatchObject({
				type: "response",
				command: "run.get",
				success: true,
				data: { run: { status: "completed" }, receipt: { status: "completed", runId } },
			});
			const receiptBefore = JSON.stringify((afterComplete as { data: { receipt: unknown } }).data.receipt);

			const request = await dispatchCommand(controller, {
				id: "req-done",
				type: "task.gate.request",
				taskId: "task_done",
				stageId: "stage_review",
				stageRevision: 1,
				runId,
				clientRequestId: "gate-done-001",
			});
			const gateId = expectGateResponse(request, "task.gate.request").gate.gateId;
			expect(expectGateResponse(
				await dispatchCommand(controller, {
					id: "app-done",
					type: "task.gate.approve",
					gateId,
					clientRequestId: "gate-done-approve",
				}),
				"task.gate.approve",
			).gate.status).toBe("approved");

			const cancelRequest = await dispatchCommand(controller, {
				id: "req-cancel",
				type: "task.gate.request",
				taskId: "task_cancel",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-cancel-001",
			});
			const cancelGateId = expectGateResponse(cancelRequest, "task.gate.request").gate.gateId;
			expect(expectGateResponse(
				await dispatchCommand(controller, {
					id: "cn-done",
					type: "task.gate.cancel",
					gateId: cancelGateId,
					clientRequestId: "gate-done-cancel",
				}),
				"task.gate.cancel",
			).gate.status).toBe("cancelled");

			const afterGates = await dispatchCommand(controller, { id: "get-run-2", type: "run.get", runId });
			expect(afterGates).toMatchObject({
				type: "response",
				command: "run.get",
				success: true,
				data: { run: { status: "completed" }, receipt: { status: "completed", runId } },
			});
			expect(JSON.stringify((afterGates as { data: { receipt: unknown } }).data.receipt)).toBe(receiptBefore);
			expect(records.filter((record) => record.type === "run.started")).toHaveLength(1);
			expect(records.filter((record) => record.type === "run.completed")).toHaveLength(1);
			expect(records.some((record) => record.type === "run.failed" || record.type === "run.cancelled")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
