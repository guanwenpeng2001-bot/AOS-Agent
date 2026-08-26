/**
 * Automation Host RPC tests for the `task.credential` control plane:
 * initialize advertisement, session ownership, payload/scope/TTL/limit
 * validation, idempotent replay, stable AutomationErrors (including
 * not_found and persistence_failed), unified stdio/TCP dispatch, and the
 * guarantee that mutation commands never enter the builtin tool / Extension
 * / MCP / model tool paths.
 */

import { mkdirSync, rmSync } from "node:fs";
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
import { RUN_LEDGER_CUSTOM_TYPE, type RunRecord } from "../src/core/run-lifecycle.ts";
import type { SandboxProvider } from "../src/core/sandbox.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../src/core/task-credential-provider.ts";
import type { TaskCredentialDeliveryReceipt, TaskCredentialScope } from "../src/core/task-credential-lease.ts";
import { TASK_CREDENTIAL_CUSTOM_TYPE } from "../src/core/task-credential-store.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../src/modes/rpc/rpc-host.ts";
import type {
	RpcAutomationResponse,
	RpcCommand,
	RpcMcpAuthResponse,
	RpcMcpContentResponse,
	RpcResponse,
} from "../src/modes/rpc/rpc-types.ts";
import { writeCanonicalRunResult } from "./support/canonical-run-terminal.ts";

type RpcDispatchResponse =
	| RpcResponse
	| RpcAutomationResponse
	| RpcMcpAuthResponse
	| RpcMcpContentResponse
	| undefined;

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

const NOW = "2026-08-16T12:00:00.000Z";
const SENTINEL = "sentinel-secret-42";

/**
 * Fake sandbox provider: declares per-binding isolation AND credential
 * delivery so the T3 per-binding sandbox facts resolve honestly.
 */
function makeSandboxProvider(): SandboxProvider {
	const capabilities = {
		filesystem: true,
		process: true,
		network: false,
		credentialIsolation: true,
		credentialDelivery: true,
	};
	return {
		id: "fake-sandbox",
		capabilities,
		prepare: async (binding) => ({
			id: `sandbox-handle-${binding.id}`,
			bindingId: binding.id,
			providerId: "fake-sandbox",
			status: "ready",
			capabilities,
			execute: async () => ({ exitCode: 0 }),
		}),
		dispose: async () => {},
	};
}

/**
 * Sandbox-enforcement policy settings whose credentials action follows
 * `credentialPolicy`: `allow` issues, `deny` hard-denies, `ask` requires a
 * recorded approval (never auto-approved by the preflight).
 */
function credentialSandboxPolicySettings(credentialPolicy: "allow" | "deny" | "ask"): {
	defaultProfile: string;
	profiles: Record<string, unknown>;
} {
	const profileId = "credential-sandbox";
	return {
		defaultProfile: profileId,
		profiles: {
			[profileId]: {
				id: profileId,
				enforcement: "sandbox",
				sandboxProvider: "fake-sandbox",
				defaultAction: "allow",
				workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
				process: { action: "allow", inheritEnvironment: false, allowEnvironment: ["PATH"], cwdScopes: ["workspace"] },
				network: { action: "allow", allowDestinations: [] },
				credentials: { action: credentialPolicy, allowNames: ["package_registry"] },
				approvals: {
					writeOutsideWorkspace: "deny",
					network: "allow",
					process: "allow",
					credentials: credentialPolicy === "ask" ? "ask" : "allow",
				},
				rules: [],
			},
		},
	};
}

/** Material-receiving target adapter; the provider forwards projections here. */
class RecordingTarget {
	received: Array<{ leaseId: string; material: Record<string, string> }> = [];
	/** Material-free capability snapshot queries the preflight resolver made. */
	capabilityCalls = 0;

	project(request: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly scopes: ReadonlyArray<TaskCredentialScope>;
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
	}): TaskCredentialDeliveryReceipt {
		this.received.push({ leaseId: request.leaseId, material: { ...request.material } });
		const receipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "succeeded",
			recordedAt: NOW,
		};
		if (request.targetId !== undefined) (receipt as { targetId?: string }).targetId = request.targetId;
		return receipt;
	}

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		this.capabilityCalls += 1;
		return {
			schemaVersion: 1,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: NOW,
		};
	}
}

function makeProvider(target?: RecordingTarget): TaskCredentialTestProvider {
	return createTaskCredentialTestProvider({
		materials: { package_registry: SENTINEL },
		now: () => NOW,
		target: target ?? new RecordingTarget(),
	});
}

const SCOPES: ReadonlyArray<TaskCredentialScope> = [
	{
		credentialName: "package_registry",
		purpose: "dependency_read",
		operations: ["read"],
		targetKinds: ["isolated_sandbox"],
	},
];

const tempDirs: string[] = [];
async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	withProvider?: boolean;
	credentialPolicy?: "allow" | "deny" | "ask";
	providerAvailable?: boolean;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	provider: TaskCredentialTestProvider | undefined;
	target: RecordingTarget | undefined;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `aos-rpc-task-credential-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	let modelCalls = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: DEFAULT_MODEL,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, streamOptions) => {
			modelCalls += 1;
			const stream = new MockAssistantStream();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const abort = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				const message = createAssistantMessage("");
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...message, stopReason: "aborted", errorMessage: "Request aborted" },
				});
			};
			if (streamOptions?.signal?.aborted) {
				abort();
				return stream;
			}
			streamOptions?.signal?.addEventListener("abort", abort, { once: true });
			void stream.result().finally(() => streamOptions?.signal?.removeEventListener("abort", abort));
			queueMicrotask(() => {
				if (streamOptions?.signal?.aborted) return;
				stream.push({ type: "start", partial: createAssistantMessage("") });
				timer = setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const settingsManager = SettingsManager.inMemory({
		executionPolicy: credentialSandboxPolicySettings(options.credentialPolicy ?? "allow"),
	});
	const modelRuntime = {
		hasConfiguredAuth: () => options.withAuth,
		checkAuth: async () => (options.withAuth ? { type: "api_key", key: "test-key" } : undefined),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "test-key" }),
	} as unknown as ModelRuntime;
	const resourceLoader = testResourceLoader();
	const target = options.withProvider === true ? new RecordingTarget() : undefined;
	const provider = options.withProvider === true ? makeProvider(target) : undefined;
	const openSession = (sessionManager: SessionManager): AgentSession =>
		new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
			sandboxProviders: [makeSandboxProvider()],
			...(provider === undefined ? {} : { taskCredentialProvider: provider }),
			...(provider === undefined
				? {}
				: {
						taskCredentialProviderAvailability: {
							available: options.providerAvailable !== false,
							declaresDelivery: options.providerAvailable !== false,
						},
					}),
			...(provider === undefined ? {} : { taskCredentialPolicyMaxTtlMs: 300_000 }),
		});

	// Session persistence only flushes to disk on the first assistant message.
	// Seed a user/assistant pair so the session file exists.
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

	let currentSession = createSeededSession(tempDir);
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
			const outgoing = currentSession;
			await outgoing.dispose();
			currentSession = openSession(SessionManager.open(sessionPath));
			if (rebindCallback !== undefined) {
				await rebindCallback();
			}
			return { cancelled: false };
		}),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {
			if (currentSession.isStreaming) await currentSession.abort();
			await currentSession.dispose();
		}),
		getModelCallCount: () => modelCalls,
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		provider,
		target,
		cleanup: async () => {
			await runtimeHost.dispose();
		},
	};
}

async function startInMemoryController(options: {
	withAuth: boolean;
	responseDelayMs: number;
	withProvider?: boolean;
	credentialPolicy?: "allow" | "deny" | "ask";
	providerAvailable?: boolean;
}): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	records: RpcHostOutputRecord[];
	provider: TaskCredentialTestProvider | undefined;
	target: RecordingTarget | undefined;
	cleanup: () => Promise<void>;
}> {
	const { runtimeHost, provider, target, cleanup } = await createRuntimeHost(options);
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, {
		output: { publish: (record) => records.push(record) } satisfies RpcHostOutputSink,
	});
	await controller.start();
	return {
		controller,
		runtimeHost,
		records,
		provider,
		target,
		cleanup: async () => {
			await controller.detachTransport();
			await cleanup();
		},
	};
}

function dispatchCommand(
	controller: RpcHostController,
	command: RpcCommand,
): Promise<RpcDispatchResponse> {
	return controller.dispatch(command);
}

function credentialEntries(session: AgentSession): Array<{ id: string; data: unknown }> {
	return session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === TASK_CREDENTIAL_CUSTOM_TYPE)
		.map((entry) => ({
			id: entry.id,
			data: (entry as { data?: unknown }).data,
		}));
}

function expectAutomationError(
	response: RpcDispatchResponse,
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

function expectGrantResponse(
	response: RpcDispatchResponse,
	command: string,
): { grant: Record<string, unknown>; leaseId?: string; bindingId?: string; idempotent?: boolean; delivery?: Record<string, unknown> } {
	expect(response).toBeDefined();
	const record = response as { type: string; command: string; success: boolean; data: Record<string, unknown> };
	expect(record.type).toBe("response");
	expect(record.command).toBe(command);
	expect(record.success).toBe(true);
	const data = record.data;
	expect(data.grant).toMatchObject({ schemaVersion: 1 });
	expect(typeof (data.grant as Record<string, unknown>).leaseId).toBe("string");
	return data as { grant: Record<string, unknown>; leaseId?: string; bindingId?: string; idempotent?: boolean };
}

function seedRun(session: AgentSession, runId: string): void {
	const sessionManager = session.sessionManager;
	sessionManager.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: runId,
			sessionId: session.sessionId,
			attempt: 1,
			status: "accepted",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" as const },
		} satisfies RunRecord,
	});
}

async function seedRunTerminal(session: AgentSession, runId: string): Promise<void> {
	await writeCanonicalRunResult(session.sessionManager, runId, {
		outcome: "completed",
		completedAt: "2026-08-16T12:00:05.000Z",
	});
}

/** Create the task graph and attach its node to the run (the T3 node-attach preflight fact). */
async function seedGraphAndAttach(
	controller: RpcHostController,
	options: {
		taskId: string;
		graphRevision?: number;
		nodeId: string;
		runId: string;
		clientRequestId: string;
	},
): Promise<void> {
	const graphRevision = options.graphRevision ?? 1;
	const created = await dispatchCommand(controller, {
		id: `${options.clientRequestId}-create`,
		type: "task.graph.create",
		taskId: options.taskId,
		graphRevision,
		nodes: [{ nodeId: options.nodeId, dependsOn: [] }],
		clientRequestId: `${options.clientRequestId}-create`,
	});
	expect(created).toMatchObject({ type: "response", command: "task.graph.create", success: true });
	const attached = await dispatchCommand(controller, {
		id: `${options.clientRequestId}-attach`,
		type: "task.graph.node.attach",
		taskId: options.taskId,
		graphRevision,
		nodeId: options.nodeId,
		runId: options.runId,
		clientRequestId: `${options.clientRequestId}-attach`,
	});
	expect(attached).toMatchObject({ type: "response", command: "task.graph.node.attach", success: true });
}

/** Request and approve a task gate so the stage-pair issue preflight passes. */
async function seedApprovedGate(
	controller: RpcHostController,
	options: {
		taskId: string;
		stageId: string;
		stageRevision: number;
		clientRequestId: string;
	},
): Promise<string> {
	const requested = await dispatchCommand(controller, {
		id: `${options.clientRequestId}-request`,
		type: "task.gate.request",
		taskId: options.taskId,
		stageId: options.stageId,
		stageRevision: options.stageRevision,
		clientRequestId: `${options.clientRequestId}-request`,
	});
	expect(requested).toMatchObject({ type: "response", command: "task.gate.request", success: true });
	const gateId = (requested as { data: { gate: { gateId: string } } }).data.gate.gateId;
	const approved = await dispatchCommand(controller, {
		id: `${options.clientRequestId}-approve`,
		type: "task.gate.approve",
		gateId,
		clientRequestId: `${options.clientRequestId}-approve`,
	});
	expect(approved).toMatchObject({ type: "response", command: "task.gate.approve", success: true });
	return gateId;
}

/**
 * Materialize the session's frozen policy boundary (capability binding +
 * policy binding + ready per-binding sandbox session) so the T3 preflight
 * facts are real. The command preflight itself never prepares anything;
 * this is fixture setup only. `preflight` is skipped when the boundary was
 * already materialized by a live run (run.start runs its own preflight).
 */
async function prepareBoundary(
	session: AgentSession,
	runId: string,
	options: { preflight?: boolean } = {},
): Promise<{
	policyBindingId: string;
	capabilityBindingId: string;
	sandboxBindingId: string;
	targetKind: string;
}> {
	if (options.preflight !== false) {
		await session.runExternalAgentPreflight(runId);
	}
	const policyBinding = session.getActiveExecutionPolicyBinding();
	const capabilityBindingId = session.getCapabilityBindingId();
	if (policyBinding === undefined || capabilityBindingId === undefined) {
		throw new Error("session policy boundary was not materialized");
	}
	return {
		policyBindingId: policyBinding.id,
		capabilityBindingId,
		sandboxBindingId: policyBinding.id,
		targetKind: "isolated_sandbox",
	};
}

/**
 * Seed a run + attached graph node and materialize the frozen policy
 * boundary in one step; returns the real binding identities the issue
 * command must carry.
 */
async function seedRunGraphAndBoundary(
	controller: RpcHostController,
	session: AgentSession,
	runId: string,
	graphClientRequestId: string,
): Promise<{
	policyBindingId: string;
	capabilityBindingId: string;
	sandboxBindingId: string;
	targetKind: string;
}> {
	seedRun(session, runId);
	await seedGraphAndAttach(controller, {
		taskId: "task_42",
		nodeId: "node_inspect",
		runId,
		clientRequestId: graphClientRequestId,
	});
	return prepareBoundary(session, runId);
}

function issueCommand(
	runId: string,
	clientRequestId: string,
	boundary: {
		policyBindingId: string;
		capabilityBindingId: string;
		sandboxBindingId: string;
		targetKind?: string;
	},
	overrides: Record<string, unknown> = {},
): RpcCommand {
	return {
		id: `issue-${clientRequestId}`,
		type: "task.credential.issue",
		taskId: "task_42",
		graphRevision: 1,
		nodeId: "node_inspect",
		runId,
		capabilityBindingId: boundary.capabilityBindingId,
		policyBindingId: boundary.policyBindingId,
		sandboxBindingId: boundary.sandboxBindingId,
		targetId: "target_sandbox",
		targetKind: boundary.targetKind,
		scopes: SCOPES,
		requestedTtlMs: 60_000,
		clientRequestId,
		...overrides,
	} as RpcCommand;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("task credential automation host rpc", () => {
	it("initialize advertises the six taskCredentialCommands while keeping protocolVersion 1", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1, withProvider: true });
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
				taskCredentialCommands: string[];
			} };
			expect(response).toMatchObject({ type: "response", command: "initialize", success: true });
			const data = response.data;
			expect(data.host).toBe("automation-host");
			expect(data.protocolVersion).toBe(1);
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
			expect(data.taskCredentialCommands).toEqual([
				"task.credential.issue",
				"task.credential.get",
				"task.credential.list",
				"task.credential.heartbeat",
				"task.credential.revoke",
				"task.credential.settle",
			]);
		} finally {
			await cleanup();
		}
	});

	it("rejects every task.credential command before initialize with host_not_initialized", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1, withProvider: true });
		try {
			for (const command of [
				issueCommand("run_001", "c1", {
					policyBindingId: "unused_before_initialize",
					capabilityBindingId: "unused_before_initialize",
					sandboxBindingId: "unused_before_initialize",
				}),
				{ id: "g1", type: "task.credential.get", leaseId: "lease_001" },
				{ id: "l1", type: "task.credential.list" },
				{
					id: "h1",
					type: "task.credential.heartbeat",
					leaseId: "lease_001",
					grantId: "grant_001",
					bindingId: "binding_001",
					heartbeatSequence: 1,
					requestedTtlMs: 60_000,
					clientRequestId: "c2",
				},
				{ id: "r1", type: "task.credential.revoke", leaseId: "lease_001", clientRequestId: "c3" },
				{ id: "s1", type: "task.credential.settle", leaseId: "lease_001", clientRequestId: "c4" },
			] as RpcCommand[]) {
				const response = await dispatchCommand(controller, command);
				expectAutomationError(response, command.type, "host_not_initialized");
			}
		} finally {
			await cleanup();
		}
	});

	it("fails closed with task_credential_unavailable when the session has no provider", async () => {
		const { controller, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 1 });
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const response = await dispatchCommand(
				controller,
				issueCommand("run_001", "c1", {
					policyBindingId: "unused",
					capabilityBindingId: "unused",
					sandboxBindingId: "unused",
				}),
			);
			expectAutomationError(response, "task.credential.issue", "task_credential_unavailable");
		} finally {
			await cleanup();
		}
	});

	it("issue creates a lease, persists task.credential entries, and never touches runs, tools, MCP, or the model", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-1");
			const before = credentialEntries(runtimeHost.session).length;

			const response = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const data = expectGrantResponse(response, "task.credential.issue");
			expect(data.idempotent).toBe(false);
			expect(data.leaseId).toMatch(/^lease_/);
			expect(data.bindingId).toMatch(/^binding_/);
			expect(data.grant).toMatchObject({
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "node_inspect",
				runId: "run_001",
				scopeCount: 1,
				status: "active",
				heartbeatSequence: 0,
				revision: 0,
			});
			expect((data.grant as Record<string, unknown>).scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
			// The provider reported a successful projection; the delivery receipt
			// is safe (ids + status + timestamp only) and never carries material.
			expect(data.delivery).toMatchObject({ status: "succeeded" });
			const after = credentialEntries(runtimeHost.session);
			expect(after.length).toBeGreaterThan(before);
			expect(JSON.stringify(after)).not.toContain(SENTINEL);
			expect(JSON.stringify(after)).not.toContain("package_registry");

			// The mutation never enters the builtin tool / Extension / MCP /
			// model tool path: no run events, no session events, no model call.
			expect(records.some((record) => record.type.startsWith("run."))).toBe(false);
			const modelCalls = (runtimeHost as unknown as { getModelCallCount: () => number }).getModelCallCount();
			expect(modelCalls).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("replays an identical issue idempotently and conflicts on a changed payload", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-2");
			const first = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const firstData = expectGrantResponse(first, "task.credential.issue");
			const entriesAfterFirst = credentialEntries(runtimeHost.session).length;

			// Same context + same clientRequestId: the durable issue replays.
			const replay = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const replayData = expectGrantResponse(replay, "task.credential.issue");
			expect(replayData.idempotent).toBe(true);
			expect(replayData.leaseId).toBe(firstData.leaseId);
			expect(credentialEntries(runtimeHost.session).length).toBe(entriesAfterFirst);

			// Same clientRequestId + a different payload conflicts. The changed
			// TTL passes the preflight (it is within the frozen bounds) but
			// changes the canonical issue payload, so the service's idempotency
			// fold reports the conflict.
			const conflict = await dispatchCommand(
				controller,
				issueCommand("run_001", "issue-001", boundary, { requestedTtlMs: 120_000 },
			));
			expectAutomationError(conflict, "task.credential.issue", "task_credential_conflict");
		} finally {
			await cleanup();
		}
	});

	it("issue enforces current-Session ownership: phantom and foreign runs are rejected", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-3");
			const phantom = await dispatchCommand(controller, issueCommand("run_missing", "issue-phantom", boundary));
			expectAutomationError(phantom, "task.credential.issue", "task_credential_binding_invalid");
			expect(credentialEntries(runtimeHost.session)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rejects forbidden payload keys at the command boundary before they reach the service", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-4");
			for (const forbidden of ["token", "secret", "material", "env", "headers", "authorization", "prompt", "command", "cwd", "path", "stdout", "stderr", "raw", "providerResponse", "providerError", "oauthCode"]) {
				const response = await dispatchCommand(
					controller,
					issueCommand("run_001", `issue-${forbidden}`, boundary, { [forbidden]: "super-secret-payload" }),
				);
				expectAutomationError(response, "task.credential.issue", "task_credential_invalid");
				expect(JSON.stringify(response)).not.toContain("super-secret-payload");
			}
			expect(credentialEntries(runtimeHost.session)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("get returns the grant and unknown leases fail with task_credential_not_found", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-5");
			const issued = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			const got = await dispatchCommand(controller, { id: "get-1", type: "task.credential.get", leaseId });
			const gotData = expectGrantResponse(got, "task.credential.get");
			expect(gotData.grant.leaseId).toBe(leaseId);

			const missing = await dispatchCommand(controller, {
				id: "get-2",
				type: "task.credential.get",
				leaseId: "lease_missing",
			});
			expectAutomationError(missing, "task.credential.get", "task_credential_not_found");
		} finally {
			await cleanup();
		}
	});

	it("list filters by taskId, runId, and status and truncates at the requested limit", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-6");
			seedRun(runtimeHost.session, "run_002");
			await seedGraphAndAttach(controller, {
				taskId: "task_42",
				graphRevision: 2,
				nodeId: "node_inspect",
				runId: "run_002",
				clientRequestId: "graph-seed-6b",
			});
			await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			await dispatchCommand(controller, issueCommand("run_002", "issue-002", boundary, { graphRevision: 2 }));

			const byRun = await dispatchCommand(controller, {
				id: "list-1",
				type: "task.credential.list",
				runId: "run_001",
			});
			const byRunData = (byRun as { data: { grants: unknown[]; truncated: boolean } }).data;
			expect(byRunData.grants).toHaveLength(1);
			expect(byRunData.truncated).toBe(false);

			const byTask = await dispatchCommand(controller, {
				id: "list-2",
				type: "task.credential.list",
				taskId: "task_42",
			});
			expect((byTask as { data: { grants: unknown[] } }).data.grants).toHaveLength(2);

			const limited = await dispatchCommand(controller, { id: "list-3", type: "task.credential.list", limit: 1 });
			const limitedData = (limited as { data: { grants: unknown[]; truncated: boolean } }).data;
			expect(limitedData.grants).toHaveLength(1);
			expect(limitedData.truncated).toBe(true);

			const badStatus = await dispatchCommand(controller, {
				id: "list-4",
				type: "task.credential.list",
				status: "not-a-status",
			} as unknown as RpcCommand);
			expectAutomationError(badStatus, "task.credential.list", "task_credential_invalid");
		} finally {
			await cleanup();
		}
	});

	it("heartbeat renews one lease, rejects stale sequences, and replays idempotently", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-7");
			const issued = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const issueData = expectGrantResponse(issued, "task.credential.issue");
			const grant = issueData.grant as Record<string, unknown>;
			const leaseId = grant.leaseId as string;
			const grantId = grant.grantId as string;
			const bindingId = grant.bindingId as string;

			// A stale sequence fails closed before any provider call or append.
			const stale = await dispatchCommand(controller, {
				id: "hb-0",
				type: "task.credential.heartbeat",
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 5,
				requestedTtlMs: 60_000,
				clientRequestId: "hb-stale",
			});
			expectAutomationError(stale, "task.credential.heartbeat", "task_lease_heartbeat_invalid");

			const entriesBefore = credentialEntries(runtimeHost.session).length;
			const beat = await dispatchCommand(controller, {
				id: "hb-1",
				type: "task.credential.heartbeat",
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "hb-001",
			});
			const beatData = expectGrantResponse(beat, "task.credential.heartbeat");
			expect(beatData.idempotent).toBe(false);
			expect((beatData.grant as Record<string, unknown>).heartbeatSequence).toBe(1);
			expect(credentialEntries(runtimeHost.session).length).toBeGreaterThan(entriesBefore);

			// Same clientRequestId + identical payload replays without appending.
			const replay = await dispatchCommand(controller, {
				id: "hb-2",
				type: "task.credential.heartbeat",
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "hb-001",
			});
			const replayData = expectGrantResponse(replay, "task.credential.heartbeat");
			expect(replayData.idempotent).toBe(true);
			expect(credentialEntries(runtimeHost.session).length).toBe(credentialEntries(runtimeHost.session).length);

			// A mismatched grant id fails closed.
			const mismatch = await dispatchCommand(controller, {
				id: "hb-3",
				type: "task.credential.heartbeat",
				leaseId,
				grantId: "grant_other",
				bindingId,
				heartbeatSequence: 2,
				requestedTtlMs: 60_000,
				clientRequestId: "hb-mismatch",
			});
			expectAutomationError(mismatch, "task.credential.heartbeat", "task_credential_conflict");
		} finally {
			await cleanup();
		}
	});

	it("revoke revokes one lease and settle settles only a delivered and revoked lease", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-8");
			const issued = await dispatchCommand(controller, issueCommand("run_001", "issue-001", boundary));
			const grant = expectGrantResponse(issued, "task.credential.issue").grant as Record<string, unknown>;
			const leaseId = grant.leaseId as string;

			// Settle on a live lease is illegal: it is not delivered AND revoked.
			const earlySettle = await dispatchCommand(controller, {
				id: "s-0",
				type: "task.credential.settle",
				leaseId,
				clientRequestId: "settle-early",
			});
			expectAutomationError(earlySettle, "task.credential.settle", "task_credential_conflict");

			const revoked = await dispatchCommand(controller, {
				id: "r-1",
				type: "task.credential.revoke",
				leaseId,
				reasonCode: "operator_revoked",
				clientRequestId: "revoke-001",
			});
			const revokeData = expectGrantResponse(revoked, "task.credential.revoke");
			expect(revokeData.idempotent).toBe(false);
			expect((revokeData.grant as Record<string, unknown>).status).toBe("revoked");
			expect((revokeData.grant as Record<string, unknown>).reasonCode).toBe("operator_revoked");

			// A replay of the same revoke is idempotent.
			const revokeReplay = await dispatchCommand(controller, {
				id: "r-2",
				type: "task.credential.revoke",
				leaseId,
				reasonCode: "operator_revoked",
				clientRequestId: "revoke-001",
			});
			expect(expectGrantResponse(revokeReplay, "task.credential.revoke").idempotent).toBe(true);

			// Revoke is durable and the issuer-side material is revoked.
			const revokedAgain = await dispatchCommand(controller, {
				id: "r-3",
				type: "task.credential.revoke",
				leaseId,
				clientRequestId: "revoke-002",
			});
			expectAutomationError(revokedAgain, "task.credential.revoke", "task_credential_conflict");

			const settled = await dispatchCommand(controller, {
				id: "s-1",
				type: "task.credential.settle",
				leaseId,
				clientRequestId: "settle-001",
			});
			const settleData = expectGrantResponse(settled, "task.credential.settle");
			expect((settleData.grant as Record<string, unknown>).status).toBe("settled");

			const unknown = await dispatchCommand(controller, {
				id: "r-4",
				type: "task.credential.revoke",
				leaseId: "lease_missing",
				clientRequestId: "revoke-missing",
			});
			expectAutomationError(unknown, "task.credential.revoke", "task_credential_not_found");

			// Never any run events or model calls: pure control plane.
			const modelCalls = (runtimeHost as unknown as { getModelCallCount: () => number }).getModelCallCount();
			expect(modelCalls).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("maps a persistence failure to the stable task_credential_persistence_failed error", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-9");
			const sessionManager = runtimeHost.session.sessionManager;
			const originalAppend = sessionManager.appendCustomEntry.bind(sessionManager);
			vi.spyOn(sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
				throw new Error("disk full");
			});
			try {
				const response = await dispatchCommand(controller, issueCommand("run_001", "issue-fail", boundary));
				expectAutomationError(response, "task.credential.issue", "task_credential_persistence_failed");
			} finally {
				sessionManager.appendCustomEntry = originalAppend;
			}
			// The failed issue never left a durable entry.
			expect(credentialEntries(runtimeHost.session)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("serves identical responses through the unified stdio and TCP dispatch path", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await controller.handleCommand({ id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-seed-10");

			// handleCommand is the stdio adapter entry; dispatch is the TCP
			// transport entry. Both route through the same handler, so the
			// credential control plane is transport-neutral by construction.
			await controller.handleCommand(issueCommand("run_001", "issue-001", boundary));
			const viaDispatch = await dispatchCommand(controller, {
				id: "list-1",
				type: "task.credential.list",
			});
			expect(viaDispatch).toMatchObject({ type: "response", command: "task.credential.list", success: true });
			const grants = (viaDispatch as { data: { grants: unknown[] } }).data.grants;
			expect(grants).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
	it("issue runs the T3 preflight: gate approval, node attach, TTL, and scope facts", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			seedRun(runtimeHost.session, "run_001");
			// Materialize the frozen policy boundary so the Session-side facts
			// (policy decision, capability binding, ready per-binding sandbox)
			// are real; the host-resolvable facts below stay the test focus.
			const boundary = await prepareBoundary(runtimeHost.session, "run_001");

			// No graph: the node-attach preflight fact cannot be established.
			const noGraph = await dispatchCommand(controller, issueCommand("run_001", "issue-pf-1", boundary));
			expectAutomationError(noGraph, "task.credential.issue", "task_credential_binding_invalid");

			// Graph created but the node is not attached to the run yet.
			const created = await dispatchCommand(controller, {
				id: "pf-create",
				type: "task.graph.create",
				taskId: "task_42",
				graphRevision: 1,
				nodes: [{ nodeId: "node_inspect", dependsOn: [] }],
				clientRequestId: "pf-create",
			});
			expect(created).toMatchObject({ type: "response", command: "task.graph.create", success: true });
			const unattached = await dispatchCommand(controller, issueCommand("run_001", "issue-pf-2", boundary));
			expectAutomationError(unattached, "task.credential.issue", "task_credential_binding_invalid");

			// Attach the node so the remaining preflight facts are observable.
			const attached = await dispatchCommand(controller, {
				id: "pf-attach",
				type: "task.graph.node.attach",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "node_inspect",
				runId: "run_001",
				clientRequestId: "pf-attach",
			});
			expect(attached).toMatchObject({ type: "response", command: "task.graph.node.attach", success: true });

			// TTL outside the frozen lease bounds.
			const badTtl = await dispatchCommand(controller, issueCommand("run_001", "issue-pf-3", boundary, { requestedTtlMs: 1 }));
			expectAutomationError(badTtl, "task.credential.issue", "task_credential_ttl_invalid");

			// A structurally invalid scope list.
			const badScope = await dispatchCommand(controller, issueCommand("run_001", "issue-pf-4", boundary, { scopes: [] }));
			expectAutomationError(badScope, "task.credential.issue", "task_credential_invalid");

			// A stage pair requires an approved gate at the exact revision.
			const pendingGate = await dispatchCommand(controller, {
				id: "pf-gate-request",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "pf-gate-request",
			});
			expect(pendingGate).toMatchObject({ type: "response", command: "task.gate.request", success: true });
			const gateId = (pendingGate as { data: { gate: { gateId: string } } }).data.gate.gateId;
			const gatedIssue = await dispatchCommand(
				controller,
				issueCommand("run_001", "issue-pf-5", boundary, { stageId: "stage_review", stageRevision: 1 },
			));
			expectAutomationError(gatedIssue, "task.credential.issue", "task_credential_gate_required");

			// A stale stage revision never passes even after the gate is approved.
			const approved = await dispatchCommand(controller, {
				id: "pf-gate-approve",
				type: "task.gate.approve",
				gateId,
				clientRequestId: "pf-gate-approve",
			});
			expect(approved).toMatchObject({ type: "response", command: "task.gate.approve", success: true });
			const staleIssue = await dispatchCommand(
				controller,
				issueCommand("run_001", "issue-pf-6", boundary, { stageId: "stage_review", stageRevision: 2 },
			));
			expectAutomationError(staleIssue, "task.credential.issue", "task_credential_gate_required");

			// Approved gate + attached node: the preflight passes and the issue lands.
			const ok = await dispatchCommand(
				controller,
				issueCommand("run_001", "issue-ok", boundary, { stageId: "stage_review", stageRevision: 1 },
			));
			const okData = expectGrantResponse(ok, "task.credential.issue");
			expect(okData.idempotent).toBe(false);
			const okActions = credentialEntries(runtimeHost.session).map((entry) => (entry.data as { action: string }).action);
			expect(okActions).toContain("issued");
			expect(okActions).toContain("delivery_succeeded");
		} finally {
			await cleanup();
		}
	});

	it("gate rejection invalidates only the rejected stage revision's leases", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-gate-invalidation");
			// Issue a lease bound to an approved gate at stage revision 1.
			await seedApprovedGate(controller, {
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 1,
				clientRequestId: "gate-rev1",
			});
			const issued = await dispatchCommand(
				controller,
				issueCommand("run_001", "issue-rev1", boundary, { stageId: "stage_review", stageRevision: 1 },
			));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			// A pending gate at revision 2 is rejected: the invalidation hook
			// fires with the revision-2 facts and must NOT over-revoke the
			// revision-1 lease.
			const second = await dispatchCommand(controller, {
				id: "gate-rev2-request",
				type: "task.gate.request",
				taskId: "task_42",
				stageId: "stage_review",
				stageRevision: 2,
				clientRequestId: "gate-rev2-request",
			});
			const secondGateId = (second as { data: { gate: { gateId: string } } }).data.gate.gateId;
			const rejected = await dispatchCommand(controller, {
				id: "gate-rev2-reject",
				type: "task.gate.reject",
				gateId: secondGateId,
				reasonCode: "operator_rejected",
				clientRequestId: "gate-rev2-reject",
			});
			expect(rejected).toMatchObject({ type: "response", command: "task.gate.reject", success: true });

			const after = await dispatchCommand(controller, { id: "get-1", type: "task.credential.get", leaseId });
			expect((after as { data: { grant: { status: string } } }).data.grant.status).toBe("active");
			const encoded = JSON.stringify(credentialEntries(runtimeHost.session));
			expect(encoded).not.toContain("gate_rejected");
		} finally {
			await cleanup();
		}
	});

	it("node settlement revokes and settles the node's leases through the graph hook", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-node-terminal");
			const issued = await dispatchCommand(controller, issueCommand("run_001", "issue-node", boundary));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;
			expect((issued as { data: { grant: { status: string } } }).data.grant.status).toBe("active");

			// The run reaches terminal, then the node settles: the graph store
			// fires onNodeTerminal and the service revokes + settles the lease.
			await seedRunTerminal(runtimeHost.session, "run_001");
			const settledNode = await dispatchCommand(controller, {
				id: "node-settle",
				type: "task.graph.node.settle",
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "node_inspect",
				clientRequestId: "node-settle",
			});
			expect(settledNode).toMatchObject({ type: "response", command: "task.graph.node.settle", success: true });

			const after = await dispatchCommand(controller, { id: "get-1", type: "task.credential.get", leaseId });
			const grant = (after as unknown as { data: { grant: Record<string, unknown> } }).data.grant;
			expect(grant.status).toBe("settled");
			expect(grant.reasonCode).toBe("node_succeeded");
			const encoded = JSON.stringify(credentialEntries(runtimeHost.session));
			expect(encoded).not.toContain("node_failed");
		} finally {
			await cleanup();
		}
	});

	it("run terminal revokes and settles the run's leases through the coordinator hooks", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 2_000,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			// run.start publishes its accepted response through the sink and
			// resolves dispatch to undefined; read the runId from the records.
			await dispatchCommand(controller, { id: "run-1", type: "run.start", message: "Hello" });
			await vi.waitFor(() =>
				expect(records.some((record) => record.type === "response" && record.id === "run-1")).toBe(true),
			);
			const accepted = records.find(
				(record) => record.type === "response" && record.id === "run-1",
			) as { data: { runId: string } };
			const runId = accepted.data.runId;
			// The run's own preflight materialized the frozen policy boundary;
			// read the real binding identities (no extra preparation: the
			// command preflight itself must never prepare anything).
			const boundary = await prepareBoundary(runtimeHost.session, runId, { preflight: false });
			await seedGraphAndAttach(controller, {
				taskId: "task_42",
				nodeId: "node_inspect",
				runId,
				clientRequestId: "graph-run-terminal",
			});
			const issued = await dispatchCommand(controller, issueCommand(runId, "issue-run", boundary));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			// The mock model stream completes the run; the coordinator's
			// onRunTerminal hook revokes + settles the run's lease.
			await vi.waitFor(() => expect(records.some((record) => record.type === "run.completed")).toBe(true), { timeout: 10_000 });
			const after = await dispatchCommand(controller, { id: "get-1", type: "task.credential.get", leaseId });
			const grant = (after as unknown as { data: { grant: Record<string, unknown> } }).data.grant;
			expect(grant.status).toBe("settled");
			expect(grant.reasonCode).toBe("run_completed");
		} finally {
			await cleanup();
		}
	});

	it("session switch tears down the outgoing session's credential service", async () => {
		const { controller, runtimeHost, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 1,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-session-switch");
			const issued = await dispatchCommand(controller, issueCommand("run_001", "issue-switch", boundary));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			const outgoingManager = runtimeHost.session.sessionManager;
			const sessionFile = outgoingManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await runtimeHost.switchSession(sessionFile!);

			// The host fired the outgoing service's session shutdown signal
			// before the incoming session was assigned: the outgoing ledger now
			// carries the revoke + settle transitions of the outstanding lease.
			const entries = outgoingManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === TASK_CREDENTIAL_CUSTOM_TYPE)
				.map((entry) => (entry as { data: { action: string; leaseId: string } }).data);
			const leaseTransitions = entries.filter((entry) => entry.leaseId === leaseId).map((entry) => entry.action);
			expect(leaseTransitions).toContain("revoked");
			expect(leaseTransitions).toContain("settled");
			expect(entries.some((entry) => entry.action === "issued")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("transport detach revokes and settles the active run's leases (worker detach)", async () => {
		const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 2_000,
			withProvider: true,
		});
		try {
			await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
			await dispatchCommand(controller, { id: "run-1", type: "run.start", message: "Hello" });
			await vi.waitFor(() =>
				expect(records.some((record) => record.type === "response" && record.id === "run-1")).toBe(true),
			);
			const accepted = records.find(
				(record) => record.type === "response" && record.id === "run-1",
			) as { data: { runId: string } };
			const runId = accepted.data.runId;
			const boundary = await prepareBoundary(runtimeHost.session, runId, { preflight: false });
			await seedGraphAndAttach(controller, {
				taskId: "task_42",
				nodeId: "node_inspect",
				runId,
				clientRequestId: "graph-worker-detach",
			});
			const issued = await dispatchCommand(
				controller,
				issueCommand(runId, "issue-detach", boundary),
			);
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			// The transport detaches while the run is active: the host cancels
			// the run and fires the worker-detach signal, which revokes and
			// settles the run's leases before the transport is unbound.
			await controller.detachTransport();

			const after = await dispatchCommand(controller, { id: "get-1", type: "task.credential.get", leaseId });
			const grant = (after as unknown as { data: { grant: Record<string, unknown> } }).data.grant;
			expect(grant.status).toBe("settled");
			const encoded = JSON.stringify(credentialEntries(runtimeHost.session));
			expect(encoded).not.toContain("session_shutdown");
		} finally {
			await cleanup();
		}
	});

	describe("T3 preflight regressions (no provider call, no append)", () => {
		/**
		 * The deny path must never reach the issuer, the projection, or the
		 * session single-writer: zero issuer grants, zero material projections,
		 * zero capability queries, zero `task.credential` appends.
		 */
		function expectNoProviderOrAppend(
			provider: TaskCredentialTestProvider | undefined,
			target: RecordingTarget | undefined,
			session: AgentSession,
		): void {
			expect(provider?.records.size ?? 0).toBe(0);
			expect(target?.received.length ?? 0).toBe(0);
			expect(target?.capabilityCalls ?? 0).toBe(0);
			expect(credentialEntries(session)).toHaveLength(0);
		}

		it("policy deny fails closed with task_credential_policy_denied", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
				credentialPolicy: "deny",
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-deny");
				const response = await dispatchCommand(controller, issueCommand("run_001", "issue-deny", boundary));
				expectAutomationError(response, "task.credential.issue", "task_credential_policy_denied");
				expectNoProviderOrAppend(provider, target, runtimeHost.session);
			} finally {
				await cleanup();
			}
		});

		it("an unapproved policy ask fails closed with task_credential_approval_required", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
				credentialPolicy: "ask",
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-ask");
				const response = await dispatchCommand(controller, issueCommand("run_001", "issue-ask", boundary));
				expectAutomationError(response, "task.credential.issue", "task_credential_approval_required");
				expectNoProviderOrAppend(provider, target, runtimeHost.session);
			} finally {
				await cleanup();
			}
		});

		it("a missing capability target fails closed with task_credential_target_unavailable", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-no-target");
				const response = await dispatchCommand(
					controller,
				issueCommand("run_001", "issue-no-target", boundary, { targetId: undefined }),
				);
				expectAutomationError(response, "task.credential.issue", "task_credential_target_unavailable");
				expectNoProviderOrAppend(provider, target, runtimeHost.session);
			} finally {
				await cleanup();
			}
		});

		it("a disposed sandbox fails closed with task_credential_target_unavailable", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-disposed");
				// Dispose the live per-binding sandbox session: the T3 sandbox
				// fact is no longer `ready`, so the preflight fails closed.
				await runtimeHost.session.getActiveSandboxSessionForCompatibility()?.dispose();
				const response = await dispatchCommand(controller, issueCommand("run_001", "issue-disposed", boundary));
				expectAutomationError(response, "task.credential.issue", "task_credential_target_unavailable");
				expectNoProviderOrAppend(provider, target, runtimeHost.session);
			} finally {
				await cleanup();
			}
		});

		it("an unavailable provider fails closed with task_credential_provider_unavailable", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
				providerAvailable: false,
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-unavailable");
				const response = await dispatchCommand(controller, issueCommand("run_001", "issue-unavailable", boundary));
				expectAutomationError(response, "task.credential.issue", "task_credential_provider_unavailable");
				expectNoProviderOrAppend(provider, target, runtimeHost.session);
			} finally {
				await cleanup();
			}
		});

		it("the legal path still issues with real frozen facts and a derived target kind", async () => {
			const { controller, runtimeHost, provider, target, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 1,
				withProvider: true,
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				const boundary = await seedRunGraphAndBoundary(controller, runtimeHost.session, "run_001", "graph-legal");
				// No targetKind on the wire: the resolver derives the only
				// declared scope target kind (`isolated_sandbox`).
				const { targetKind: _omitted, ...boundaryWithoutKind } = boundary;
				const response = await dispatchCommand(
					controller,
				issueCommand("run_001", "issue-legal", boundaryWithoutKind),
				);
				const data = expectGrantResponse(response, "task.credential.issue");
				expect(data.idempotent).toBe(false);
				// The provider was reached exactly once for issue + once for
				// the projection; the capability snapshot was queried once per
				// operation preflight (issue + project).
				expect(provider?.records.size ?? 0).toBe(1);
				expect(target?.received.length ?? 0).toBe(1);
				expect(credentialEntries(runtimeHost.session).length).toBeGreaterThan(0);
			} finally {
				await cleanup();
			}
		});

		it("the first cancel request revokes the run's live leases before the terminal transition", async () => {
			const { controller, runtimeHost, records, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 5_000,
				withProvider: true,
			});
			try {
				await dispatchCommand(controller, { id: "init-1", type: "initialize", protocolVersion: 1 });
				await dispatchCommand(controller, { id: "run-1", type: "run.start", message: "Hello" });
				await vi.waitFor(() =>
					expect(records.some((record) => record.type === "response" && record.id === "run-1")).toBe(true),
				{ timeout: 10_000 },
			);
			const accepted = records.find(
				(record) => record.type === "response" && record.id === "run-1",
			) as { data: { runId: string } };
			const runId = accepted.data.runId;
			const boundary = await prepareBoundary(runtimeHost.session, runId, { preflight: false });
			await seedGraphAndAttach(controller, {
				taskId: "task_42",
				nodeId: "node_inspect",
				runId,
				clientRequestId: "graph-cancel",
			});
			const issued = await dispatchCommand(controller, issueCommand(runId, "issue-cancel", boundary));
			const leaseId = expectGrantResponse(issued, "task.credential.issue").leaseId!;

			// Cancel is a request, not the terminal transition: the Run record
			// stays non-terminal while the credential service already revoked
			// the run's live lease (the terminal event settles it later).
			const runBefore = await dispatchCommand(controller, { id: "get-1", type: "run.get", runId });
			const statusBefore = (runBefore as { data: { run: { status: string } } }).data.run.status;
			const cancelled = await dispatchCommand(controller, { id: "cn-1", type: "run.cancel", runId });
			expect(cancelled).toMatchObject({ type: "response", command: "run.cancel", success: true });

			const after = await dispatchCommand(controller, { id: "get-2", type: "task.credential.get", leaseId });
			const grant = (after as unknown as { data: { grant: Record<string, unknown> } }).data.grant;
			expect(grant.status).toBe("revoked");
			expect(grant.reasonCode).toBe("run_cancelled");
			// The Run fact was NOT rewritten by the cancel intent: the record
			// still reflects the pre-cancel state.
			const runAfter = await dispatchCommand(controller, { id: "get-3", type: "run.get", runId });
			const statusAfter = (runAfter as { data: { run: { status: string } } }).data.run.status;
			expect(statusAfter).toBe(statusBefore);
			expect(statusAfter).not.toBe("cancelled");

			// The terminal event eventually settles the revoked lease.
			await vi.waitFor(() => expect(records.some((record) => record.type === "run.cancelled")).toBe(true), {
				timeout: 10_000,
			});
			const settled = await dispatchCommand(controller, { id: "get-4", type: "task.credential.get", leaseId });
			const settledGrant = (settled as unknown as { data: { grant: Record<string, unknown> } }).data.grant;
			expect(settledGrant.status).toBe("settled");
		} finally {
			await cleanup();
		}
	});
});
});
