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
import { RUN_LEDGER_CUSTOM_TYPE, type RunReceipt, type RunRecord } from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../src/modes/rpc/rpc-host.ts";
import type {
	RpcAutomationResponse,
	RpcCommand,
	RpcResponse,
	TaskGraphNodeView,
	TaskGraphRecord,
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
	const tempDir = join(tmpdir(), `aos-rpc-task-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	// Seed a user/assistant pair so the session file exists even for tests that
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
			// its coordinator, TaskGateStore, and TaskGraphStore against the
			// restored session.
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
): Promise<RpcResponse | RpcAutomationResponse | undefined> {
	return controller.dispatch(command);
}

function graphEntries(session: AgentSession): Array<{ id: string; data: unknown }> {
	return session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "task.graph")
		.map((entry) => ({
			id: entry.id,
			data: (entry as { data?: unknown }).data,
		}));
}

function expectAutomationError(
	response: RpcResponse | RpcAutomationResponse | undefined,
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

function expectGraphMutationResponse(
	response: RpcResponse | RpcAutomationResponse | undefined,
	command: "task.graph.create" | "task.graph.node.attach" | "task.graph.node.settle",
): { graph: TaskGraphRecord; node?: TaskGraphNodeView; idempotent: boolean } {
	expect(response).toBeDefined();
	const record = response as {
		type: string;
		command: string;
		success: boolean;
		data: { graph: TaskGraphRecord; node?: TaskGraphNodeView; idempotent: boolean };
	};
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(true);
	const data = record.data;
	expect(data.graph.schemaVersion).toBe(1);
	expect(typeof data.graph.createdAt).toBe("string");
	expect(typeof data.idempotent).toBe("boolean");
	return data;
}

function expectGraphGetResponse(
	response: RpcResponse | RpcAutomationResponse | undefined,
	command: string,
): TaskGraphRecord {
	expect(response).toBeDefined();
	const record = response as { type: string; command: string; success: boolean; data: { graph: TaskGraphRecord } };
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(true);
	return record.data.graph;
}

function expectGraphListResponse(
	response: RpcResponse | RpcAutomationResponse | undefined,
	command: string,
): { graphs: TaskGraphRecord[]; truncated: boolean } {
	expect(response).toBeDefined();
	const record = response as {
		type: string;
		command: string;
		success: boolean;
		data: { graphs: TaskGraphRecord[]; truncated: boolean };
	};
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(true);
	return record.data;
}

async function waitForRecord(
	records: readonly RpcHostOutputRecord[],
	predicate: (record: RpcHostOutputRecord) => boolean,
	timeout = 8000,
): Promise<void> {
	await vi.waitFor(() => expect(records.some(predicate)).toBe(true), { timeout });
}

async function startRunAndGetId(
	controller: RpcHostController,
	records: readonly RpcHostOutputRecord[],
	command: { id?: string; type: "run.start"; message: string; deadlineAt?: string },
): Promise<string> {
	const id = command.id ?? "run-start";
	// run.start publishes its accepted response through the output sink and
	// resolves dispatch to undefined, so read the accepted record from the sink.
	const pending = dispatchCommand(controller, command as RpcCommand);
	let runId: string | undefined;
	await vi.waitFor(() => {
		const accepted = records.find(
			(record) =>
				record.type === "response" &&
				record.id === id &&
				record.command === "run.start" &&
				record.success === true,
		) as { data?: { runId?: string } } | undefined;
		if (accepted === undefined) {
			const failure = records.find((record) => record.type === "response" && record.id === id);
			if (failure !== undefined) throw new Error(`run.start failed: ${JSON.stringify(failure)}`);
			expect(accepted).toBeDefined();
			return;
		}
		runId = accepted.data?.runId;
		expect(runId).toBeDefined();
	});
	await pending;
	return runId!;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const PENDING_GRAPH_NODES = [
	{ nodeId: "inspect", dependsOn: [] },
	{ nodeId: "implement", dependsOn: ["inspect"] },
	{ nodeId: "review", dependsOn: ["implement"], gateRef: { stageId: "stage_review", stageRevision: 1 } },
];

describe("task graph automation host rpc", () => {
	it("initialize advertises the five taskGraphCommands while keeping protocolVersion 1", async () => {
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
				taskGraphCommands: string[];
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
			expect(data.taskGraphCommands).toEqual([
				"task.graph.create",
				"task.graph.get",
				"task.graph.list",
				"task.graph.node.attach",
				"task.graph.node.settle",
			]);
		} finally {
			await cleanup();
		}
	});

	it("rejects every task.graph command before initialize with host_not_initialized", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			for (const command of [
				{ id: "c1", type: "task.graph.create", taskId: "task_1", graphRevision: 1, nodes: [{ nodeId: "a", dependsOn: [] }], clientRequestId: "c1" },
				{ id: "g1", type: "task.graph.get", taskId: "task_1", graphRevision: 1 },
				{ id: "l1", type: "task.graph.list" },
				{ id: "a1", type: "task.graph.node.attach", taskId: "task_1", graphRevision: 1, nodeId: "a", runId: "run_1", clientRequestId: "a1" },
				{ id: "s1", type: "task.graph.node.settle", taskId: "task_1", graphRevision: 1, nodeId: "a", clientRequestId: "s1" },
			] as RpcCommand[]) {
				const response = await dispatchCommand(controller, command);
				expectAutomationError(response, command.type, "host_not_initialized");
			}
		} finally {
			await cleanup();
		}
	});

	it("create persists the immutable DAG with derived availability and never touches runs or the model", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
		});
		try {
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const response = await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: PENDING_GRAPH_NODES,
				clientRequestId: "graph-create-001",
			});
			const data = expectGraphMutationResponse(response, "task.graph.create");
			expect(data.idempotent).toBe(false);
			expect(data.node).toBeUndefined();
			expect(data.graph).toMatchObject({
				schemaVersion: 1,
				sessionId: runtimeHost.session.sessionId,
				taskId: "task_42",
				graphRevision: 1,
				summary: { status: "active", pending: 3, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
			});
			expect(data.graph.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			const [inspect, implement, review] = data.graph.nodes;
			expect(inspect).toMatchObject({
				nodeId: "inspect",
				dependsOn: [],
				status: "pending",
				nodeRevision: 0,
				availability: "ready",
				blockingNodeIds: [],
			});
			expect(implement).toMatchObject({
				nodeId: "implement",
				dependsOn: ["inspect"],
				status: "pending",
				nodeRevision: 0,
				availability: "waiting_dependencies",
				blockingNodeIds: ["inspect"],
			});
			expect(review).toMatchObject({
				nodeId: "review",
				dependsOn: ["implement"],
				status: "pending",
				nodeRevision: 0,
				availability: "waiting_dependencies",
				blockingNodeIds: ["implement"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
			});

			const entries = graphEntries(runtimeHost.session);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.data).toMatchObject({
				schemaVersion: 1,
				action: "created",
				clientRequestId: "graph-create-001",
				graph: {
					schemaVersion: 1,
					sessionId: runtimeHost.session.sessionId,
					taskId: "task_42",
					graphRevision: 1,
					nodes: [
						{ nodeId: "inspect", dependsOn: [], status: "pending", nodeRevision: 0 },
						{ nodeId: "implement", dependsOn: ["inspect"], status: "pending", nodeRevision: 0 },
						{ nodeId: "review", dependsOn: ["implement"], status: "pending", nodeRevision: 0 },
					],
				},
			});

			// Graph commands are control-plane only: no run records, no run events,
			// and no model prompt.
			expect(promptSpy).not.toHaveBeenCalled();
			expect(records.some((record) => record.type.startsWith("run."))).toBe(false);
			expect(automationRecords(records)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("create rejects cycles, unknown deps, unsafe ids, missing keys, and forbidden payload keys", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: PENDING_GRAPH_NODES,
				clientRequestId: "graph-create-001",
			});
			expectGraphMutationResponse(first, "task.graph.create");

			// Same business key with a different clientRequestId conflicts.
			const duplicate = await dispatchCommand(controller, {
				id: "create-2",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "a", dependsOn: [] }],
				clientRequestId: "graph-create-002",
			});
			expectAutomationError(duplicate, "task.graph.create", "task_graph_conflict");

			// A higher graphRevision is a fresh immutable graph.
			const nextRevision = await dispatchCommand(controller, {
				id: "create-3",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 2,
				nodes: [{ nodeId: "a", dependsOn: [] }],
				clientRequestId: "graph-create-003",
			});
			expect(expectGraphMutationResponse(nextRevision, "task.graph.create").graph.graphRevision).toBe(2);

			// Dependency cycles are rejected with a dedicated code.
			const cycle = await dispatchCommand(controller, {
				id: "create-4",
				type: "task.graph.create",
				taskId: "task_cycle",
				graphRevision: 1,
				nodes: [
					{ nodeId: "a", dependsOn: ["b"] },
					{ nodeId: "b", dependsOn: ["a"] },
				],
				clientRequestId: "graph-create-004",
			});
			expectAutomationError(cycle, "task.graph.create", "task_graph_dependency_cycle");

			// Unknown dependency, self dependency, and duplicate node ids are invalid.
			for (const nodes of [
				[{ nodeId: "a", dependsOn: ["ghost"] }],
				[{ nodeId: "a", dependsOn: ["a"] }],
				[
					{ nodeId: "a", dependsOn: [] },
					{ nodeId: "a", dependsOn: [] },
				],
			]) {
				const invalid = await dispatchCommand(
					controller,
					{ id: "create-bad", type: "task.graph.create", taskId: "task_bad", graphRevision: 1, nodes, clientRequestId: "bad-1" } as RpcCommand,
				);
				expectAutomationError(invalid, "task.graph.create", "task_graph_invalid");
			}

			// graphRevision must be a positive safe integer.
			for (const graphRevision of [0, -1, 1.5]) {
				const invalid = await dispatchCommand(
					controller,
					{ id: "create-bad", type: "task.graph.create", taskId: "task_42", graphRevision, nodes: [{ nodeId: "a", dependsOn: [] }], clientRequestId: "bad-2" } as RpcCommand,
				);
				expectAutomationError(invalid, "task.graph.create", "task_graph_invalid");
			}

			// Empty node sets and missing clientRequestId are invalid.
			const emptyNodes = await dispatchCommand(
				controller,
				{ id: "create-bad", type: "task.graph.create", taskId: "task_9", graphRevision: 1, nodes: [], clientRequestId: "bad-3" } as RpcCommand,
			);
			expectAutomationError(emptyNodes, "task.graph.create", "task_graph_invalid");
			const missingKey = await dispatchCommand(
				controller,
				{ id: "create-bad", type: "task.graph.create", taskId: "task_9", graphRevision: 1, nodes: [{ nodeId: "a", dependsOn: [] as string[] }] } as unknown as RpcCommand,
			);
			expectAutomationError(missingKey, "task.graph.create", "task_graph_invalid");

			// Unsafe opaque identifiers (paths / URLs / controls) are rejected.
			for (const taskId of ["../etc/passwd", "https://host.invalid/x", "task\n42"]) {
				const invalid = await dispatchCommand(
					controller,
					{ id: "create-bad", type: "task.graph.create", taskId, graphRevision: 1, nodes: [{ nodeId: "a", dependsOn: [] }], clientRequestId: "bad-4" } as RpcCommand,
				);
				expectAutomationError(invalid, "task.graph.create", "task_graph_invalid");
			}

			// Forbidden payload keys are rejected at the command boundary and never persist.
			const forbidden = await dispatchCommand(
				controller,
				{ id: "create-forbidden", type: "task.graph.create", taskId: "task_9", graphRevision: 1, nodes: [{ nodeId: "a", dependsOn: [] }], clientRequestId: "bad-5", prompt: "secret text" } as RpcCommand,
			);
			expectAutomationError(forbidden, "task.graph.create", "task_graph_invalid");
			const forbiddenJson = JSON.stringify(forbidden);
			expect(forbiddenJson).not.toContain("secret text");
			expect(forbiddenJson).not.toContain("prompt");

			// Only the two successful creates were written; no raw payload leaked.
			const entries = graphEntries(runtimeHost.session);
			expect(entries).toHaveLength(2);
			expect(JSON.stringify(entries)).not.toContain("secret text");
			expect(JSON.stringify(entries)).not.toContain("ghost");
		} finally {
			await cleanup();
		}
	});

	it("get returns the graph with derived node views and stays read-only", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: PENDING_GRAPH_NODES,
				clientRequestId: "graph-create-001",
			});
			const entriesBefore = graphEntries(runtimeHost.session).length;

			const graph = expectGraphGetResponse(
				await dispatchCommand(controller, { id: "get-1", type: "task.graph.get", taskId: "task_42", graphRevision: 1 }),
				"task.graph.get",
			);
			expect(graph).toMatchObject({ taskId: "task_42", graphRevision: 1, summary: { status: "active", pending: 3 } });
			expect(graph.nodes[0]).toMatchObject({ nodeId: "inspect", availability: "ready" });
			expect(graph.nodes[1]).toMatchObject({ nodeId: "implement", availability: "waiting_dependencies" });

			const missing = await dispatchCommand(controller, { id: "get-2", type: "task.graph.get", taskId: "task_unknown", graphRevision: 1 });
			expectAutomationError(missing, "task.graph.get", "task_graph_not_found");

			const invalid = await dispatchCommand(
				controller,
				{ id: "get-3", type: "task.graph.get", taskId: "task_42", graphRevision: 0 } as RpcCommand,
			);
			expectAutomationError(invalid, "task.graph.get", "task_graph_invalid");

			// Reads never append transitions.
			expect(graphEntries(runtimeHost.session).length).toBe(entriesBefore);
		} finally {
			await cleanup();
		}
	});

	it("list filters by taskId/graphRevision/status and enforces the server limit", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			for (let index = 0; index < 60; index += 1) {
				await dispatchCommand(controller, {
					id: `create-${index}`,
					type: "task.graph.create",
					taskId: index % 2 === 0 ? "task_even" : "task_odd",
					graphRevision: index + 1,
					nodes: [{ nodeId: `n${index}`, dependsOn: [] }],
					clientRequestId: `create-${index}`,
				});
			}

			// Default limit is 50 with truncation; no cross-session cursor exists.
			const defaultList = await dispatchCommand(controller, { id: "list-1", type: "task.graph.list" });
			const defaultData = expectGraphListResponse(defaultList, "task.graph.list");
			expect(defaultData.graphs).toHaveLength(50);
			expect(defaultData.truncated).toBe(true);

			// Explicit limit up to 100.
			const explicit = await dispatchCommand(controller, { id: "list-2", type: "task.graph.list", limit: 100 });
			const explicitData = expectGraphListResponse(explicit, "task.graph.list");
			expect(explicitData.graphs).toHaveLength(60);
			expect(explicitData.truncated).toBe(false);

			// Filters are exact matches.
			const filtered = await dispatchCommand(controller, {
				id: "list-3",
				type: "task.graph.list",
				taskId: "task_even",
				status: "active",
				limit: 100,
			});
			const filteredData = expectGraphListResponse(filtered, "task.graph.list");
			expect(filteredData.graphs).toHaveLength(30);
			expect(filteredData.truncated).toBe(false);
			expect(filteredData.graphs.every((graph) => graph.taskId === "task_even" && graph.summary.status === "active")).toBe(true);

			const byRevision = await dispatchCommand(controller, {
				id: "list-4",
				type: "task.graph.list",
				taskId: "task_odd",
				graphRevision: 4,
			});
			const byRevisionData = expectGraphListResponse(byRevision, "task.graph.list");
			expect(byRevisionData.graphs).toHaveLength(1);
			expect(byRevisionData.graphs[0]).toMatchObject({ taskId: "task_odd", graphRevision: 4 });

			// Limits above the server maximum are invalid.
			const overLimit = await dispatchCommand(
				controller,
				{ id: "list-5", type: "task.graph.list", limit: 101 } as RpcCommand,
			);
			expectAutomationError(overLimit, "task.graph.list", "task_graph_invalid");

			// Unsafe filter identifiers are invalid.
			const unsafeFilter = await dispatchCommand(
				controller,
				{ id: "list-6", type: "task.graph.list", taskId: "../etc" } as RpcCommand,
			);
			expectAutomationError(unsafeFilter, "task.graph.list", "task_graph_invalid");
		} finally {
			await cleanup();
		}
	});

	it("attach requires a pending ready node and an accepted or running run of the current session", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 60,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: PENDING_GRAPH_NODES,
				clientRequestId: "graph-create-001",
			});

			// Unknown graph and unknown node fail with stable codes.
			const unknownGraph = await dispatchCommand(controller, {
				id: "attach-0",
				type: "task.graph.node.attach",
				taskId: "task_missing",
				graphRevision: 1,
				nodeId: "inspect",
				runId: "run_ghost",
				clientRequestId: "attach-0",
			});
			expectAutomationError(unknownGraph, "task.graph.node.attach", "task_graph_not_found");
			const unknownNode = await dispatchCommand(controller, {
				id: "attach-0b",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "ghost",
				runId: "run_ghost",
				clientRequestId: "attach-0b",
			});
			expectAutomationError(unknownNode, "task.graph.node.attach", "task_graph_node_not_found");

			// Unknown run in the current session fails with run_not_found.
			const unknownRun = await dispatchCommand(controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "inspect",
				runId: "run_ghost",
				clientRequestId: "attach-1",
			});
			expectAutomationError(unknownRun, "task.graph.node.attach", "task_graph_run_not_found");

			// A node whose dependencies are not satisfied is not eligible.
			const notEligible = await dispatchCommand(controller, {
				id: "attach-2",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "implement",
				runId: "run_ghost",
				clientRequestId: "attach-2",
			});
			expectAutomationError(notEligible, "task.graph.node.attach", "task_graph_node_not_eligible");

			// Attach while the run is accepted (before run.started) succeeds.
			const runId = await startRunAndGetId(controller, records, { id: "run-1", type: "run.start", message: "hello" });
			const attachAccepted = await dispatchCommand(controller, {
				id: "attach-3",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "inspect",
				runId,
				clientRequestId: "attach-3",
			});
			const attached = expectGraphMutationResponse(attachAccepted, "task.graph.node.attach");
			expect(attached.idempotent).toBe(false);
			expect(attached.node).toMatchObject({
				nodeId: "inspect",
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId: runtimeHost.session.sessionId, runId },
				availability: null,
				blockingNodeIds: [],
			});
			expect(attached.graph.nodes[0]).toMatchObject({ nodeId: "inspect", status: "running" });
			expect(attached.graph.summary).toEqual({ status: "active", pending: 2, running: 1, succeeded: 0, failed: 0, cancelled: 0 });

			// A node can never be attached to a second Run: the conflict is raised
			// before the Run lookup, so an arbitrary runId is enough.
			const secondAttach = await dispatchCommand(controller, {
				id: "attach-4",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "inspect",
				runId: "run_ghost",
				clientRequestId: "attach-4",
			});
			expectAutomationError(secondAttach, "task.graph.node.attach", "task_graph_node_conflict");

			// A terminal Run is not attachable: settle the inspected node first so
			// implement becomes ready, then attach it with the completed run.
			await waitForRecord(records, (record) => record.type === "run.completed");
			const settle = await dispatchCommand(controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "inspect",
				clientRequestId: "settle-1",
			});
			expect(expectGraphMutationResponse(settle, "task.graph.node.settle").node).toMatchObject({
				nodeId: "inspect",
				status: "succeeded",
			});
			const terminalAttach = await dispatchCommand(controller, {
				id: "attach-5",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "implement",
				runId,
				clientRequestId: "attach-5",
			});
			expectAutomationError(terminalAttach, "task.graph.node.attach", "task_graph_run_not_found");

			// Extra undocumented keys are rejected at the command boundary.
			const extraKey = await dispatchCommand(
				controller,
				{ id: "attach-6", type: "task.graph.node.attach", taskId: "task_42", graphRevision: 1, nodeId: "review", runId: "run_ghost", clientRequestId: "attach-6", status: "running" } as RpcCommand,
			);
			expectAutomationError(extraKey, "task.graph.node.attach", "task_graph_invalid");

			// Only the successful attach and settle were persisted.
			expect(graphEntries(runtimeHost.session)).toHaveLength(3);
		} finally {
			await cleanup();
		}
	});

	it("consumes Task Gate state read-only for eligibility: pending/approved/rejected gates", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 60 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_gate",
				graphRevision: 1,
				nodes: [
					{ nodeId: "gated", dependsOn: [], gateRef: { stageId: "stage_review", stageRevision: 1 } },
					{ nodeId: "blocked", dependsOn: [], gateRef: { stageId: "stage_block", stageRevision: 1 } },
				],
				clientRequestId: "graph-create-001",
			});

			// A missing Gate yields waiting_gate and attach is rejected.
			const missingGate = await dispatchCommand(controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_gate",
				graphRevision: 1,
				nodeId: "gated",
				runId: "run_ghost",
				clientRequestId: "attach-1",
			});
			expectAutomationError(missingGate, "task.graph.node.attach", "task_graph_node_not_eligible");

			// A pending Gate still blocks eligibility.
			const requestGate = await dispatchCommand(controller, {
				id: "gate-1",
				type: "task.gate.request",
				taskId: "task_gate",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-request-001",
			});
			const gateId = (requestGate as { data: { gate: { gateId: string } } }).data.gate.gateId;
			const pendingGate = await dispatchCommand(controller, {
				id: "attach-2",
				type: "task.graph.node.attach",
				taskId: "task_gate",
				graphRevision: 1,
				nodeId: "gated",
				runId: "run_ghost",
				clientRequestId: "attach-2",
			});
			expectAutomationError(pendingGate, "task.graph.node.attach", "task_graph_node_not_eligible");

			// After Gate approval the node becomes ready and attach succeeds.
			const approve = await dispatchCommand(controller, {
				id: "gate-approve-1",
				type: "task.gate.approve",
				gateId,
				actorId: "operator_7",
				clientRequestId: "gate-approve-001",
			});
			expect(approve).toMatchObject({ type: "response", command: "task.gate.approve", success: true });
			const runId = await startRunAndGetId(controller, records, { id: "run-1", type: "run.start", message: "gated run" });
			const eligible = await dispatchCommand(controller, {
				id: "attach-3",
				type: "task.graph.node.attach",
				taskId: "task_gate",
				graphRevision: 1,
				nodeId: "gated",
				runId,
				clientRequestId: "attach-3",
			});
			expect(expectGraphMutationResponse(eligible, "task.graph.node.attach").node).toMatchObject({
				nodeId: "gated",
				status: "running",
				gateRef: { stageId: "stage_review", stageRevision: 1 },
			});

			// A rejected Gate blocks the node. The next run waits for the previous
			// run's terminal so the single-active-run boundary is respected.
			await waitForRecord(records, (record) => record.type === "run.completed");
			const blockGate = await dispatchCommand(controller, {
				id: "gate-2",
				type: "task.gate.request",
				taskId: "task_gate",
				stageId: "stage_block",
				stageRevision: 1,
				clientRequestId: "gate-request-002",
			});
			const blockGateId = (blockGate as { data: { gate: { gateId: string } } }).data.gate.gateId;
			const reject = await dispatchCommand(controller, {
				id: "gate-reject-1",
				type: "task.gate.reject",
				gateId: blockGateId,
				actorId: "operator_7",
				reasonCode: "quality_check_failed",
				clientRequestId: "gate-reject-001",
			});
			expect(reject).toMatchObject({ type: "response", command: "task.gate.reject", success: true });
			const secondRunId = await startRunAndGetId(controller, records, { id: "run-2", type: "run.start", message: "blocked run" });
			const blocked = await dispatchCommand(controller, {
				id: "attach-4",
				type: "task.graph.node.attach",
				taskId: "task_gate",
				graphRevision: 1,
				nodeId: "blocked",
				runId: secondRunId,
				clientRequestId: "attach-4",
			});
			expectAutomationError(blocked, "task.graph.node.attach", "task_graph_node_not_eligible");
			await dispatchCommand(controller, { id: "cancel-2", type: "run.cancel", runId: secondRunId });

			// The graph read reflects the live Gate state without writing anything.
			const graph = expectGraphGetResponse(
				await dispatchCommand(controller, { id: "get-1", type: "task.graph.get", taskId: "task_gate", graphRevision: 1 }),
				"task.graph.get",
			);
			expect(graph.nodes[0]).toMatchObject({ nodeId: "gated", availability: null, status: "running" });
			expect(graph.nodes[1]).toMatchObject({ nodeId: "blocked", availability: "blocked", gateStatus: "rejected" });
			expect(graphEntries(runtimeHost.session)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("settle maps completed/failed/cancelled terminal receipts onto nodes", async () => {
		// completed -> succeeded
		const completed = await startInMemoryController({ withAuth: true, responseDelayMs: 60 });
		try {
			await dispatchCommand(completed.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(completed.controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "done", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			const completedRunId = await startRunAndGetId(completed.controller, completed.records, {
				id: "run-1",
				type: "run.start",
				message: "ok",
			});
			const attachDone = await dispatchCommand(completed.controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "done",
				runId: completedRunId,
				clientRequestId: "attach-1",
			});
			expect(expectGraphMutationResponse(attachDone, "task.graph.node.attach").node?.status).toBe("running");
			await waitForRecord(completed.records, (record) => record.type === "run.completed");
			const settleDone = await dispatchCommand(completed.controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "done",
				clientRequestId: "settle-1",
			});
			const settledDone = expectGraphMutationResponse(settleDone, "task.graph.node.settle");
			expect(settledDone.idempotent).toBe(false);
			expect(settledDone.node).toMatchObject({
				nodeId: "done",
				status: "succeeded",
				nodeRevision: 2,
				runRef: { runId: completedRunId },
				availability: null,
			});
		} finally {
			await completed.cleanup();
		}

		// failed -> failed (deadline-expired run settles as run.failed)
		const failed = await startInMemoryController({ withAuth: true, responseDelayMs: 2000 });
		try {
			await dispatchCommand(failed.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(failed.controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "boom", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			const deadlineAt = new Date(Date.now() + 150).toISOString();
			const failedRunId = await startRunAndGetId(failed.controller, failed.records, {
				id: "run-2",
				type: "run.start",
				message: "boom",
				deadlineAt,
			});
			const attachBoom = await dispatchCommand(failed.controller, {
				id: "attach-2",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "boom",
				runId: failedRunId,
				clientRequestId: "attach-2",
			});
			expect(expectGraphMutationResponse(attachBoom, "task.graph.node.attach").node?.status).toBe("running");
			await waitForRecord(failed.records, (record) => record.type === "run.failed");
			const settleBoom = await dispatchCommand(failed.controller, {
				id: "settle-2",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "boom",
				clientRequestId: "settle-2",
			});
			expect(expectGraphMutationResponse(settleBoom, "task.graph.node.settle").node).toMatchObject({
				nodeId: "boom",
				status: "failed",
				nodeRevision: 2,
			});
		} finally {
			await failed.cleanup();
		}

		// cancelled -> cancelled
		const cancelled = await startInMemoryController({ withAuth: true, responseDelayMs: 2000 });
		try {
			await dispatchCommand(cancelled.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(cancelled.controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "stop", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			const cancelledRunId = await startRunAndGetId(cancelled.controller, cancelled.records, {
				id: "run-3",
				type: "run.start",
				message: "stop",
			});
			const attachStop = await dispatchCommand(cancelled.controller, {
				id: "attach-3",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "stop",
				runId: cancelledRunId,
				clientRequestId: "attach-3",
			});
			expect(expectGraphMutationResponse(attachStop, "task.graph.node.attach").node?.status).toBe("running");
			const cancelResponse = await dispatchCommand(cancelled.controller, {
				id: "cancel-3",
				type: "run.cancel",
				runId: cancelledRunId,
			});
			expect(cancelResponse).toMatchObject({ type: "response", command: "run.cancel", success: true });
			await waitForRecord(cancelled.records, (record) => record.type === "run.cancelled");
			const settleStop = await dispatchCommand(cancelled.controller, {
				id: "settle-3",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "stop",
				clientRequestId: "settle-3",
			});
			expect(expectGraphMutationResponse(settleStop, "task.graph.node.settle").node).toMatchObject({
				nodeId: "stop",
				status: "cancelled",
				nodeRevision: 2,
			});
		} finally {
			await cancelled.cleanup();
		}

		// A mixed graph derives the aggregate summary and status filter from the
		// settled nodes (completed + cancelled -> cancelled, since there is no failure).
		const mixed = await startInMemoryController({ withAuth: true, responseDelayMs: 60 });
		try {
			await dispatchCommand(mixed.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(mixed.controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [
					{ nodeId: "done", dependsOn: [] },
					{ nodeId: "stop", dependsOn: [] },
				],
				clientRequestId: "graph-create-001",
			});
			for (const [nodeId, terminalType, expectedNodeStatus, runMessage] of [
				["done", "run.completed", "succeeded", "one"],
				["stop", "run.cancelled", "cancelled", "two"],
			] as const) {
				const runId = await startRunAndGetId(mixed.controller, mixed.records, {
					id: `run-${nodeId}`,
					type: "run.start",
					message: runMessage,
				});
				const attach = await dispatchCommand(mixed.controller, {
					id: `attach-${nodeId}`,
					type: "task.graph.node.attach",
					taskId: "task_42",
					graphRevision: 1,
					nodeId,
					runId,
					clientRequestId: `attach-${nodeId}`,
				});
				expect(expectGraphMutationResponse(attach, "task.graph.node.attach").node?.status).toBe("running");
				if (terminalType === "run.cancelled") {
					await dispatchCommand(mixed.controller, { id: `cancel-${nodeId}`, type: "run.cancel", runId });
				}
				await waitForRecord(mixed.records, (record) => record.type === terminalType);
				const settle = await dispatchCommand(mixed.controller, {
					id: `settle-${nodeId}`,
					type: "task.graph.node.settle",
					taskId: "task_42",
					graphRevision: 1,
					nodeId,
					clientRequestId: `settle-${nodeId}`,
				});
				expect(expectGraphMutationResponse(settle, "task.graph.node.settle").node?.status).toBe(expectedNodeStatus);
			}

			const graph = expectGraphGetResponse(
				await dispatchCommand(mixed.controller, { id: "get-1", type: "task.graph.get", taskId: "task_42", graphRevision: 1 }),
				"task.graph.get",
			);
			expect(graph.summary).toEqual({ status: "cancelled", pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 1 });

			const cancelledList = expectGraphListResponse(
				await dispatchCommand(mixed.controller, { id: "list-1", type: "task.graph.list", status: "cancelled" }),
				"task.graph.list",
			);
			expect(cancelledList.graphs.map((item) => item.taskId)).toEqual(["task_42"]);
		} finally {
			await mixed.cleanup();
		}
	});

	it("settle refuses non-terminal runs, rejects caller status, and never rewrites the receipt", async () => {
		const { controller, records, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 2000 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "live", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			const runId = await startRunAndGetId(controller, records, { id: "run-1", type: "run.start", message: "slow" });
			const attach = await dispatchCommand(controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "live",
				runId,
				clientRequestId: "attach-1",
			});
			expect(expectGraphMutationResponse(attach, "task.graph.node.attach").node?.status).toBe("running");

			// A still-running run cannot be settled; nothing is appended.
			const notTerminal = await dispatchCommand(controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "live",
				clientRequestId: "settle-1",
			});
			expectAutomationError(notTerminal, "task.graph.node.settle", "task_graph_run_not_terminal");

			// settle accepts no caller-supplied status or terminal text.
			const callerStatus = await dispatchCommand(
				controller,
				{ id: "settle-2", type: "task.graph.node.settle", taskId: "task_42", graphRevision: 1, nodeId: "live", clientRequestId: "settle-2", status: "completed" } as RpcCommand,
			);
			expectAutomationError(callerStatus, "task.graph.node.settle", "task_graph_invalid");
			const callerText = await dispatchCommand(
				controller,
				{ id: "settle-3", type: "task.graph.node.settle", taskId: "task_42", graphRevision: 1, nodeId: "live", clientRequestId: "settle-3", finalText: "secret" } as RpcCommand,
			);
			expectAutomationError(callerText, "task.graph.node.settle", "task_graph_invalid");

			// settle on an unattached node and on unknown graph/node fail with stable codes.
			await dispatchCommand(controller, {
				id: "create-2",
				type: "task.graph.create",
				taskId: "task_43",
				graphRevision: 1,
				nodes: [{ nodeId: "ghost-node", dependsOn: [] }],
				clientRequestId: "graph-create-002",
			});
			const pendingNode = await dispatchCommand(controller, {
				id: "settle-4",
				type: "task.graph.node.settle",
				taskId: "task_43",
				graphRevision: 1,
				nodeId: "ghost-node",
				clientRequestId: "settle-4",
			});
			expectAutomationError(pendingNode, "task.graph.node.settle", "task_graph_node_conflict");
			const unknownGraph = await dispatchCommand(controller, {
				id: "settle-5",
				type: "task.graph.node.settle",
				taskId: "task_missing",
				graphRevision: 1,
				nodeId: "live",
				clientRequestId: "settle-5",
			});
			expectAutomationError(unknownGraph, "task.graph.node.settle", "task_graph_not_found");
			const unknownNode = await dispatchCommand(controller, {
				id: "settle-6",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "ghost",
				clientRequestId: "settle-6",
			});
			expectAutomationError(unknownNode, "task.graph.node.settle", "task_graph_node_not_found");

			// The run completes through its normal lifecycle; the receipt is untouched.
			await waitForRecord(records, (record) => record.type === "run.completed");
			const runGet = await dispatchCommand(controller, { id: "run-get-1", type: "run.get", runId });
			const receiptBefore = JSON.stringify((runGet as { data: { receipt: unknown } }).data.receipt);
			const settle = await dispatchCommand(controller, {
				id: "settle-7",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "live",
				clientRequestId: "settle-7",
			});
			expect(expectGraphMutationResponse(settle, "task.graph.node.settle").node).toMatchObject({
				nodeId: "live",
				status: "succeeded",
			});
			const runGetAfter = await dispatchCommand(controller, { id: "run-get-2", type: "run.get", runId });
			expect(JSON.stringify((runGetAfter as { data: { receipt: unknown } }).data.receipt)).toBe(receiptBefore);

			// A terminal node cannot be settled again with a new key.
			const reopen = await dispatchCommand(controller, {
				id: "settle-8",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "live",
				clientRequestId: "settle-8",
			});
			expectAutomationError(reopen, "task.graph.node.settle", "task_graph_node_conflict");

			// A repeated settle with the same key replays the durable result.
			const replay = await dispatchCommand(controller, {
				id: "settle-9",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "live",
				clientRequestId: "settle-7",
			});
			const replayed = expectGraphMutationResponse(replay, "task.graph.node.settle");
			expect(replayed.idempotent).toBe(true);
			expect(replayed.node).toMatchObject({ nodeId: "live", status: "succeeded", nodeRevision: 2 });
		} finally {
			await cleanup();
		}
	});

	it("settle rejects inconsistent run record and receipt facts with state_mismatch", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "mismatch", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});

			// Seed a Run ledger directly: accepted + started, then attach while running.
			const sessionId = runtimeHost.session.sessionId;
			const runId = "run_mismatch";
			const model = { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" as const };
			const sessionManager = runtimeHost.session.sessionManager;
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: { id: runId, sessionId, attempt: 1, status: "accepted", model } satisfies RunRecord,
			});
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "started",
				runId,
				startedAt: "2026-08-16T12:00:00.000Z",
			});
			const attach = await dispatchCommand(controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "mismatch",
				runId,
				clientRequestId: "attach-1",
			});
			expect(expectGraphMutationResponse(attach, "task.graph.node.attach").node?.status).toBe("running");

			// A terminal receipt and a later conflicting accepted record make the
			// record and receipt facts disagree.
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "terminal",
				receipt: { runId, sessionId, status: "completed", usage: { input: 0, output: 0, total: 0 } } satisfies RunReceipt,
				endedAt: "2026-08-16T12:00:05.000Z",
			});
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: { id: runId, sessionId, attempt: 1, status: "failed", model } satisfies RunRecord,
			});

			const settle = await dispatchCommand(controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "mismatch",
				clientRequestId: "settle-1",
			});
			expectAutomationError(settle, "task.graph.node.settle", "task_graph_run_state_mismatch");

			// Nothing was appended for the rejected settle: the ledger still holds
			// only the create and the attach transitions.
			expect(graphEntries(runtimeHost.session)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("settle rejects a terminal run record that has no persisted receipt", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "no-receipt", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});

			// Seed a Run ledger that claims a terminal record status without ever
			// persisting a terminal receipt: accepted + started, then a later
			// accepted record with a terminal status.
			const sessionId = runtimeHost.session.sessionId;
			const runId = "run_no_receipt";
			const model = { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" as const };
			const sessionManager = runtimeHost.session.sessionManager;
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: { id: runId, sessionId, attempt: 1, status: "accepted", model } satisfies RunRecord,
			});
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "started",
				runId,
				startedAt: "2026-08-16T12:00:00.000Z",
			});
			const attach = await dispatchCommand(controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "no-receipt",
				runId,
				clientRequestId: "attach-1",
			});
			expect(expectGraphMutationResponse(attach, "task.graph.node.attach").node?.status).toBe("running");

			// The record now claims a terminal status while no receipt exists.
			sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: { id: runId, sessionId, attempt: 1, status: "completed", model } satisfies RunRecord,
			});

			const settle = await dispatchCommand(controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "no-receipt",
				clientRequestId: "settle-1",
			});
			expectAutomationError(settle, "task.graph.node.settle", "task_graph_run_state_mismatch");

			// The rejected settle appended nothing: only the create and attach.
			expect(graphEntries(runtimeHost.session)).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("replays identical writes idempotently and canonicalizes reordered node arrays", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [
					{ nodeId: "a", dependsOn: [] },
					{ nodeId: "b", dependsOn: ["a"] },
				],
				clientRequestId: "graph-create-001",
			});
			const firstData = expectGraphMutationResponse(first, "task.graph.create");
			expect(firstData.idempotent).toBe(false);

			// Identical replay returns the same durable graph without a second entry.
			const replay = await dispatchCommand(controller, {
				id: "create-2",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [
					{ nodeId: "a", dependsOn: [] },
					{ nodeId: "b", dependsOn: ["a"] },
				],
				clientRequestId: "graph-create-001",
			});
			const replayed = expectGraphMutationResponse(replay, "task.graph.create");
			expect(replayed.idempotent).toBe(true);
			expect(replayed.graph.createdAt).toBe(firstData.graph.createdAt);

			// Reordered input is the same canonical payload.
			const reordered = await dispatchCommand(controller, {
				id: "create-3",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [
					{ nodeId: "b", dependsOn: ["a"] },
					{ nodeId: "a", dependsOn: [] },
				],
				clientRequestId: "graph-create-001",
			});
			expect(expectGraphMutationResponse(reordered, "task.graph.create").idempotent).toBe(true);
			expect(graphEntries(runtimeHost.session)).toHaveLength(1);

			// The same clientRequestId with a different payload is a conflict.
			const conflict = await dispatchCommand(controller, {
				id: "create-4",
				type: "task.graph.create",
				taskId: "task_43",
				graphRevision: 1,
				nodes: [{ nodeId: "a", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			expectAutomationError(conflict, "task.graph.create", "task_graph_idempotency_conflict");
			expect(graphEntries(runtimeHost.session)).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("reports persistence failures without guessing success", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const appendSpy = vi
				.spyOn(runtimeHost.session.sessionManager, "appendCustomEntry")
				.mockImplementation(() => {
					throw new Error("disk full");
				});
			try {
				const create = await dispatchCommand(controller, {
					id: "create-1",
					type: "task.graph.create",
					taskId: "task_42",
					graphRevision: 1,
					nodes: [{ nodeId: "a", dependsOn: [] }],
					clientRequestId: "graph-create-001",
				});
				expectAutomationError(create, "task.graph.create", "task_graph_persistence_failed");
			} finally {
				appendSpy.mockRestore();
			}

			// The failed write never produced a graph; re-reading confirms absence.
			const missing = await dispatchCommand(controller, {
				id: "get-1",
				type: "task.graph.get",
				taskId: "task_42",
				graphRevision: 1,
			});
			expectAutomationError(missing, "task.graph.get", "task_graph_not_found");
			expect(graphEntries(runtimeHost.session)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rebinds the graph store to the switched session without leaking graphs", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const first = await dispatchCommand(controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_a",
				graphRevision: 1,
				nodes: [{ nodeId: "n1", dependsOn: [] }],
				clientRequestId: "create-1",
			});
			expectGraphMutationResponse(first, "task.graph.create");
			const firstSessionId = runtimeHost.session.sessionId;

			// Switch to a fresh session file: graphs must not leak across sessions.
			const switchDir = join(
				tmpdir(),
				`aos-rpc-task-graph-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

			const missing = await dispatchCommand(controller, {
				id: "get-1",
				type: "task.graph.get",
				taskId: "task_a",
				graphRevision: 1,
			});
			expectAutomationError(missing, "task.graph.get", "task_graph_not_found");

			// The new session has its own graph namespace and writes its own entries.
			const second = await dispatchCommand(controller, {
				id: "create-2",
				type: "task.graph.create",
				taskId: "task_b",
				graphRevision: 1,
				nodes: [{ nodeId: "n2", dependsOn: [] }],
				clientRequestId: "create-2",
			});
			const secondData = expectGraphMutationResponse(second, "task.graph.create");
			expect(secondData.graph.sessionId).toBe(runtimeHost.session.sessionId);
			expect(graphEntries(runtimeHost.session)).toHaveLength(1);
			rmSync(switchDir, { recursive: true, force: true });
		} finally {
			await cleanup();
		}
	});

	it("recovers graphs and replays idempotent transitions after a host restart", async () => {
		const first = await startInMemoryController({ withAuth: true, responseDelayMs: 60 });
		let sessionPath: string | undefined;
		let runId: string | undefined;
		try {
			await dispatchCommand(first.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const create = await dispatchCommand(first.controller, {
				id: "create-1",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "n1", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			expectGraphMutationResponse(create, "task.graph.create");
			runId = await startRunAndGetId(first.controller, first.records, { id: "run-1", type: "run.start", message: "hi" });
			const attach = await dispatchCommand(first.controller, {
				id: "attach-1",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "n1",
				runId,
				clientRequestId: "graph-attach-001",
			});
			expect(expectGraphMutationResponse(attach, "task.graph.node.attach").node?.status).toBe("running");
			await waitForRecord(first.records, (record) => record.type === "run.completed");
			const settle = await dispatchCommand(first.controller, {
				id: "settle-1",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "n1",
				clientRequestId: "graph-settle-001",
			});
			expect(expectGraphMutationResponse(settle, "task.graph.node.settle").node).toMatchObject({
				nodeId: "n1",
				status: "succeeded",
			});
			sessionPath = first.runtimeHost.session.sessionFile;
			expect(sessionPath).toBeDefined();
			expect(sessionPath !== undefined && existsSync(sessionPath)).toBe(true);
		} finally {
			await first.cleanup();
		}

		// A fresh host over the same session file folds the transitions back.
		expect(sessionPath).toBeDefined();
		const second = await startInMemoryController({ withAuth: true, responseDelayMs: 1, sessionPath });
		try {
			await dispatchCommand(second.controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const graph = expectGraphGetResponse(
				await dispatchCommand(second.controller, {
					id: "get-1",
					type: "task.graph.get",
					taskId: "task_42",
					graphRevision: 1,
				}),
				"task.graph.get",
			);
			expect(graph.nodes[0]).toMatchObject({ nodeId: "n1", status: "succeeded", nodeRevision: 2, runRef: { runId } });
			expect(graph.summary).toEqual({ status: "succeeded", pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 });

			// The recovered store still applies the state machine: the settle replay
			// returns the durable terminal without appending, and a fresh create on
			// the same business key replays.
			const settleReplay = await dispatchCommand(second.controller, {
				id: "settle-2",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "n1",
				clientRequestId: "graph-settle-001",
			});
			const replayed = expectGraphMutationResponse(settleReplay, "task.graph.node.settle");
			expect(replayed.idempotent).toBe(true);
			expect(replayed.node).toMatchObject({ nodeId: "n1", status: "succeeded" });
			const createReplay = await dispatchCommand(second.controller, {
				id: "create-2",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "n1", dependsOn: [] }],
				clientRequestId: "graph-create-001",
			});
			expect(expectGraphMutationResponse(createReplay, "task.graph.create").idempotent).toBe(true);
			expect(graphEntries(second.runtimeHost.session)).toHaveLength(3);
		} finally {
			await second.cleanup();
		}
	});

	it("preserves session_busy while a run is active and keeps graph commands working", async () => {
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 300,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			expectGraphMutationResponse(
				await dispatchCommand(controller, {
					id: "create-1",
					type: "task.graph.create",
					taskId: "task_busy",
					graphRevision: 1,
					nodes: [{ nodeId: "node_a", dependsOn: [] }],
					clientRequestId: "create-1",
				}),
				"task.graph.create",
			);

			const runId = await startRunAndGetId(controller, records, {
				id: "run-1",
				type: "run.start",
				message: "busy",
			});

			// A second run while the first is active is still rejected with the
			// retryable session_busy contract; graph commands do not clear it.
			const busyDispatch = dispatchCommand(controller, {
				id: "run-2",
				type: "run.start",
				message: "busy again",
			});
			await vi.waitFor(() => {
				const busy = records.find((record) => record.type === "response" && record.id === "run-2") as
					| { command?: string; success?: boolean; error?: { code?: string; retryable?: boolean } }
					| undefined;
				expect(busy).toBeDefined();
				expect(busy?.command).toBe("run.start");
				expect(busy?.success).toBe(false);
				expect(busy?.error?.code).toBe("session_busy");
				expect(busy?.error?.retryable).toBe(true);
			});
			await busyDispatch;

			// Graph control-plane commands keep working while the session is busy,
			// and the attach does not start a second run.
			expect(expectGraphMutationResponse(
				await dispatchCommand(controller, {
					id: "att-1",
					type: "task.graph.node.attach",
					taskId: "task_busy",
					graphRevision: 1,
					nodeId: "node_a",
					runId,
					clientRequestId: "att-1",
				}),
				"task.graph.node.attach",
			).node).toMatchObject({ nodeId: "node_a", status: "running" });
			expect(records.filter((record) => record.type === "run.started")).toHaveLength(1);

			await waitForRecord(records, (record) => record.type === "run.completed");
			expect(expectGraphMutationResponse(
				await dispatchCommand(controller, {
					id: "set-1",
					type: "task.graph.node.settle",
					taskId: "task_busy",
					graphRevision: 1,
					nodeId: "node_a",
					clientRequestId: "set-1",
				}),
				"task.graph.node.settle",
			).node).toMatchObject({ nodeId: "node_a", status: "succeeded" });

			const secondRunId = await startRunAndGetId(controller, records, {
				id: "run-3",
				type: "run.start",
				message: "after terminal",
			});
			expect(secondRunId).not.toBe(runId);
			await vi.waitFor(() => {
				expect(records.filter((record) => record.type === "run.completed")).toHaveLength(2);
			});
		} finally {
			await cleanup();
		}
	});
});
