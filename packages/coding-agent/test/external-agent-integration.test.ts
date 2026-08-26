/**
 * Governed External Agent Adapter integration over the Automation Host path.
 *
 * Covers the trusted selection/probe gate, mapping-before-started ordering,
 * Remote Operation reuse (`startRemoteOperation` wrapping the adapter driver),
 * cancel/deadline wiring with side-effect-unknown fail-closed settlement,
 * unsupported external resume rejection, and the no-selection legacy path.
 *
 * Hydration note: this suite imports only the core `@aos-agent/ai` entrypoint
 * and a minimal local ResourceLoader, so it runs under `npm ci --ignore-scripts`
 * without generated model catalogs.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { createAgentRuntimeCompositionFactory } from "../src/core/agent-runtime-composition.ts";
import { getAgentCanonicalSession, getAgentSessionLedger } from "../src/core/agent-session-facade.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ExternalAgentExecutionContext, ExternalAgentPrepareRequest } from "../src/core/external-agent-adapter.ts";
import {
	createExternalAgentPreparedBinding,
	ExternalAgentError,
	type ExternalAgentAdapter,
	type ExternalAgentCapabilityFlags,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentErrorCode,
	type ExternalAgentEvent,
	type ExternalAgentHandle,
	type ExternalAgentPreparedBinding,
	type ExternalAgentProbeContext,
	type ExternalAgentReceipt,
	type ExternalAgentStartRequest,
	type ExternalAgentTarget,
} from "../src/core/external-agent-adapter.ts";
import {
	createExternalAgentAdapterRegistry,
	type ExternalAgentAdapterRegistry,
} from "../src/core/external-agent-registry.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ExecutionAuditQuery } from "../src/core/execution-audit-query.ts";
import {
	startRemoteOperation,
	RemoteOperationError,
	type RemoteOperationLease,
	type RemoteOperationSideEffectState,
} from "../src/core/remote-operation.ts";
import type { ExternalExecutionRef } from "../src/core/external-session-mapping.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { RUN_LEDGER_CUSTOM_TYPE } from "../src/core/run-lifecycle.ts";
import { SessionManager, type SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../src/modes/rpc/rpc-host.ts";
import { createExternalAgentRemoteInvoker } from "../src/modes/rpc/rpc-host.ts";
import type { ExternalAgentAdapterDescriptor } from "../src/core/external-agent-registry.ts";
import { writeCanonicalRunResult } from "./support/canonical-run-terminal.ts";

// agent-session.ts statically imports values from @aos-agent/ai/compat, whose
// entrypoint pulls in a gitignored generated catalog that is absent under
// `npm ci --ignore-scripts`. Mock only the symbols the exercised paths touch.
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

vi.mock("@aos-agent/ai/providers/all", () => ({}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

const NOW = "2026-08-16T00:00:00.000Z";

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

/** Minimal ResourceLoader with no compat/generated-catalog imports. */
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

function externalRef(): ExternalExecutionRef {
	return { namespace: "test-agent", externalSessionId: "ext-session-1" };
}

function readySnapshot(
	adapterId: string,
	targetId: string,
	capabilities: Partial<ExternalAgentCapabilityFlags> = {},
): ExternalAgentCapabilitySnapshot {
	return {
		schemaVersion: 1,
		adapterId,
		targetId,
		protocol: { name: "test-protocol", version: "1" },
		status: "ready",
		capabilities: {
			start: true,
			events: "metadata",
			cancel: "strong",
			receipt: "terminal",
			resume: false,
			artifacts: false,
			toolGateway: false,
			...capabilities,
		},
		observedAt: NOW,
	};
}

function startedEvent(): ExternalAgentEvent {
	return { type: "started", external: externalRef(), timestamp: NOW };
}

function progressEvent(sequence: number, phase?: string): ExternalAgentEvent {
	return {
		type: "progress",
		external: externalRef(),
		sequence,
		...(phase === undefined ? {} : { phase }),
		timestamp: NOW,
	};
}

function artifactEvent(): ExternalAgentEvent {
	return {
		type: "artifact",
		external: externalRef(),
		artifact: { id: "artifact-1", kind: "output", mediaType: "text/plain" },
		timestamp: NOW,
	};
}

function completedReceipt(extra: Partial<ExternalAgentReceipt> = {}): ExternalAgentReceipt {
	return {
		schemaVersion: 1,
		external: externalRef(),
		status: "completed",
		endedAt: NOW,
		artifactRefs: [],
		sideEffects: "none",
		...extra,
	};
}

function cancelledReceipt(sideEffects: RemoteOperationSideEffectState = "none"): ExternalAgentReceipt {
	return {
		schemaVersion: 1,
		external: externalRef(),
		status: "cancelled",
		endedAt: NOW,
		artifactRefs: [],
		sideEffects,
	};
}

function failedReceipt(code: ExternalAgentErrorCode, sideEffects: RemoteOperationSideEffectState = "none"): ExternalAgentReceipt {
	return {
		schemaVersion: 1,
		external: externalRef(),
		status: "failed",
		endedAt: NOW,
		artifactRefs: [],
		sideEffects,
		error: { code, retryable: false, sideEffects },
	};
}

/** Fake adapter handle; cancel may resolve a pending receipt. */
class FakeExternalAgentHandle implements ExternalAgentHandle {
	readonly external: ExternalExecutionRef;
	readonly events: AsyncIterable<ExternalAgentEvent>;
	readonly receipt: Promise<ExternalAgentReceipt>;
	cancelCalls = 0;
	private readonly receiptOnCancel: ExternalAgentReceipt | undefined;
	private resolvePendingReceipt: ((receipt: ExternalAgentReceipt) => void) | undefined;

	constructor(options: {
		external: ExternalExecutionRef;
		events?: ReadonlyArray<ExternalAgentEvent>;
		receipt?: ExternalAgentReceipt;
		/** Resolve the pending receipt with this value on the first cancel(). */
		receiptOnCancel?: ExternalAgentReceipt;
	}) {
		this.external = options.external;
		this.events = {
			async *[Symbol.asyncIterator]() {
				for (const event of options.events ?? []) yield event;
			},
		};
		this.receiptOnCancel = options.receiptOnCancel;
		if (options.receipt !== undefined) {
			this.receipt = Promise.resolve(options.receipt);
		} else {
			this.receipt = new Promise<ExternalAgentReceipt>((resolve) => {
				this.resolvePendingReceipt = resolve;
			});
		}
	}

	async cancel(): Promise<void> {
		this.cancelCalls += 1;
		if (this.receiptOnCancel !== undefined && this.resolvePendingReceipt !== undefined) {
			const resolve = this.resolvePendingReceipt;
			this.resolvePendingReceipt = undefined;
			resolve(this.receiptOnCancel);
		}
	}

	/** Resolve the pending terminal receipt directly (no cancel intent). */
	resolveReceipt(receipt: ExternalAgentReceipt): void {
		if (this.resolvePendingReceipt !== undefined) {
			const resolve = this.resolvePendingReceipt;
			this.resolvePendingReceipt = undefined;
			resolve(receipt);
		}
	}

	async heartbeat(): Promise<RemoteOperationLease> {
		throw new RemoteOperationError("invalid");
	}
}

/** Fake in-process adapter with injectable probe/start behavior. */
class FakeExternalAgentAdapter implements ExternalAgentAdapter {
	readonly id: string;
	readonly targets: ReadonlySet<string>;
	probeCalls = 0;
	prepareCalls = 0;
	startCalls = 0;
	probeError: unknown;
	probeSnapshot: ExternalAgentCapabilitySnapshot | undefined;
	/** Never settle probe and ignore the abort signal entirely. */
	probeHang = false;
	prepareError: unknown;
	prepareOverride:
		| ((request: ExternalAgentPrepareRequest, snapshot: ExternalAgentCapabilitySnapshot) => ExternalAgentPreparedBinding)
		| undefined;
	handle: ExternalAgentHandle | undefined;
	lastProbeContext: ExternalAgentProbeContext | undefined;
	lastStartRequest: ExternalAgentStartRequest | undefined;
	lastStartContext: ExternalAgentExecutionContext | undefined;

	constructor(id = "test-adapter", targets: ReadonlyArray<string> = ["target-1"]) {
		this.id = id;
		this.targets = new Set(targets);
	}

	async probe(target: ExternalAgentTarget, context: ExternalAgentProbeContext): Promise<ExternalAgentCapabilitySnapshot> {
		this.probeCalls += 1;
		this.lastProbeContext = context;
		if (this.probeHang) {
			// A target that ignores the signal and never settles: the Host await
			// itself must still be bounded by the probe AbortSignal.
			return new Promise<ExternalAgentCapabilitySnapshot>(() => {});
		}
		if (this.probeError !== undefined) throw this.probeError;
		if (this.probeSnapshot !== undefined) return this.probeSnapshot;
		if (context.signal.aborted) throw new Error("probe aborted by signal");
		return readySnapshot(this.id, target.targetId);
	}

	async prepare(
		request: ExternalAgentPrepareRequest,
		snapshot: ExternalAgentCapabilitySnapshot,
	): Promise<ExternalAgentPreparedBinding> {
		this.prepareCalls += 1;
		if (this.prepareOverride !== undefined) return this.prepareOverride(request, snapshot);
		if (this.prepareError !== undefined) throw this.prepareError;
		return createExternalAgentPreparedBinding(request, snapshot);
	}

	async start(
		request: ExternalAgentStartRequest,
		context: ExternalAgentExecutionContext,
	): Promise<ExternalAgentHandle> {
		this.startCalls += 1;
		this.lastStartRequest = request;
		this.lastStartContext = context;
		if (this.handle === undefined) throw new Error("no fake handle configured");
		return this.handle;
	}
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(records: RpcHostOutputRecord[]): ParsedOutputLine[] {
	return records.map((record) => record as unknown as ParsedOutputLine);
}

function responsesFor(records: RpcHostOutputRecord[], id: string): ParsedOutputLine[] {
	return parseOutputLines(records).filter((record) => record.id === id && record.type === "response");
}

function responseRunId(records: RpcHostOutputRecord[], id: string): string {
	const response = responsesFor(records, id)[0];
	const data = response?.data;
	if (typeof data !== "object" || data === null || typeof (data as { runId?: unknown }).runId !== "string") {
		throw new Error(`Response ${id} did not include a runId`);
	}
	return (data as { runId: string }).runId;
}

function runEventsOfType(records: RpcHostOutputRecord[], type: string): ParsedOutputLine[] {
	return parseOutputLines(records).filter((record) => record.type === type);
}

function terminalEvents(records: RpcHostOutputRecord[]): ParsedOutputLine[] {
	return parseOutputLines(records).filter(
		(record) => record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
	);
}

function externalAgentEvents(records: RpcHostOutputRecord[]): ParsedOutputLine[] {
	return parseOutputLines(records).filter(
		(record) =>
			record.type === "run.event" &&
			typeof record.event === "object" &&
			record.event !== null &&
			(record.event as { type?: unknown }).type === "external_agent_event",
	);
}

function customEntries(
	sessionManager: { getEntries(): SessionEntry[] },
	customType: string,
): Array<Extract<SessionEntry, { type: "custom" }>> {
	return sessionManager.getEntries().filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && entry.customType === customType,
	);
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	externalAgentRegistry?: ExternalAgentAdapterRegistry;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	sessionManager: SessionManager;
	getSession: () => AgentSession;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `aos-external-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? DEFAULT_MODEL;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
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
	let initialExternalAgentRegistry = options.externalAgentRegistry;
	const runtimeComposition = createAgentRuntimeCompositionFactory({
		...(options.externalAgentRegistry === undefined
			? {}
			: {
				externalAgentRegistry: () => {
					const registry = initialExternalAgentRegistry ?? createExternalAgentAdapterRegistry();
					initialExternalAgentRegistry = undefined;
					return registry;
				},
			}),
	});

	const openSession = (sessionManager: SessionManager): AgentSession => {
		return new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
			runtimeComposition,
		});
	};

	const initialSessionManager = SessionManager.create(tempDir);
	let currentSession = openSession(initialSessionManager);
	let prepareRebindCallback: Parameters<AgentSessionRuntime["setPrepareSessionRebind"]>[0];

	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setPrepareSessionRebind: vi.fn((callback) => {
			prepareRebindCallback = callback;
		}),
		switchSession: vi.fn(async (sessionPath: string) => {
			const previousSession = currentSession;
			const nextSession = openSession(SessionManager.open(sessionPath));
			const preparedRebind = await prepareRebindCallback?.(nextSession, previousSession);
			currentSession = nextSession;
			preparedRebind?.commit();
			await preparedRebind?.disposePrevious?.(AbortSignal.timeout(5_000));
			await previousSession.dispose();
			await preparedRebind?.activate?.();
			return { cancelled: false };
		}),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		sessionManager: initialSessionManager,
		getSession: () => currentSession,
		cleanup: async () => {
			try {
				if (currentSession.isStreaming) {
					await currentSession.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			currentSession.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

async function startInMemoryController(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	externalAgentRegistry?: ExternalAgentAdapterRegistry;
}): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	sessionManager: SessionManager;
	getSession: () => AgentSession;
	records: RpcHostOutputRecord[];
	cleanup: () => Promise<void>;
}> {
	const { runtimeHost, sessionManager, getSession, cleanup } = await createRuntimeHost(options);
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, {
		output: { publish: (record) => records.push(record) } as RpcHostOutputSink,
	});
	await controller.start();
	return { controller, runtimeHost, sessionManager, getSession, records, cleanup };
}

function registerFakeAdapter(
	registry: ExternalAgentAdapterRegistry,
	adapter: FakeExternalAgentAdapter,
	targets: ReadonlyArray<string> = ["target-1"],
): void {
	registry.register(adapter, { targets });
}


describe("createExternalAgentRemoteInvoker", () => {
	it("maps a completed adapter receipt to a bounded operation result", async () => {
		let cancelCalls = 0;
		const adapterRun = {
			receipt: Promise.resolve(
				completedReceipt({
					artifactRefs: [{ id: "artifact-1", kind: "output" }],
					sideEffects: "associated",
				}),
			),
			cancel: async () => {
				cancelCalls += 1;
			},
			heartbeat: async () => {
				throw new RemoteOperationError("invalid");
			},
		} as never;
		const invoker = createExternalAgentRemoteInvoker(adapterRun);
		const result = await invoker.execute(
			{ operationId: "run:1" } as never,
			{ operationId: "run:1" } as never,
		);
		expect(result).toMatchObject({
			artifactRefs: [{ id: "artifact-1", kind: "output" }],
			sideEffects: "associated",
		});
		await invoker.cancel("run:1");
		expect(cancelCalls).toBe(1);
	});

	it("preserves side effects on failed receipts and maps confirmed cancellation", async () => {
		const failed = createExternalAgentRemoteInvoker({
			receipt: Promise.resolve(failedReceipt("external_agent_start_failed", "unknown")),
			cancel: async () => {},
			heartbeat: async () => {
				throw new RemoteOperationError("invalid");
			},
		} as never);
		await expect(
			failed.execute({ operationId: "run:1" } as never, { operationId: "run:1" } as never),
		).rejects.toMatchObject({ category: "invalid", sideEffects: "unknown" });

		const cancelled = createExternalAgentRemoteInvoker({
			receipt: Promise.resolve(cancelledReceipt("none")),
			cancel: async () => {},
			heartbeat: async () => {
				throw new RemoteOperationError("invalid");
			},
		} as never);
		await expect(
			cancelled.execute({ operationId: "run:1" } as never, { operationId: "run:1" } as never),
		).rejects.toMatchObject({ category: "cancelled", sideEffects: "none" });
	});

	it("fails closed on heartbeat without a lease and resolves with a lease when the handle provides one", async () => {
		// Near-future expiry: the operation contract schedules a timer from the
		// expiry, and a far-future fixture (e.g. 2099) exceeds Node's 2^31ms
		// timeout cap and emits a TimeoutOverflowWarning.
		const lease: RemoteOperationLease = {
			leaseId: "lease-1",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const invoker = createExternalAgentRemoteInvoker({
			receipt: Promise.resolve(completedReceipt()),
			cancel: async () => {},
			heartbeat: async () => lease,
		} as never);
		// The operation contract fails closed without a lease.
		const noLease = startRemoteOperation(invoker, { operationId: "run:1" }, {});
		await expect(noLease.heartbeat()).rejects.toMatchObject({ category: "invalid" });
		await expect(noLease.receipt).resolves.toMatchObject({ status: "completed" });
		// With a lease the operation delegates to the adapter handle heartbeat.
		const withLease = startRemoteOperation(
			invoker,
			{ operationId: "run:2", lease },
			{},
		);
		await expect(withLease.heartbeat()).resolves.toEqual(lease);
		await expect(withLease.receipt).resolves.toMatchObject({ status: "completed", lease });
	});
});

describe("Automation Host external agent integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("advertises safe adapter descriptors on initialize and rejects an unknown target before probing", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		registerFakeAdapter(registry, adapter);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "i0", type: "initialize", protocolVersion: 1 });
			const initialize = responsesFor(records, "i0")[0];
			expect(initialize).toMatchObject({ command: "initialize", success: true });
			const externalAgentAdapters = (initialize.data as { externalAgentAdapters?: ExternalAgentAdapterDescriptor[] })
				.externalAgentAdapters;
			expect(externalAgentAdapters).toEqual([{ adapterId: "test-adapter", displayName: "test-adapter", version: "1" }]);

			await controller.handleCommand({
				id: "r0",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "unknown-target" },
			});
			const response = responsesFor(records, "r0")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_target_not_found");
			expect(adapter.probeCalls).toBe(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("rejects a probe failure and a capability gate failure before any preflight", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const probing = new FakeExternalAgentAdapter();
		probing.probeError = new Error("boom");
		registerFakeAdapter(registry, probing);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});
		try {
			await controller.handleCommand({ id: "init-p", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r1",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const probeResponse = responsesFor(records, "r1")[0];
			expect((probeResponse.error as { code: string }).code).toBe("external_agent_probe_failed");
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}

		const registry2 = createExternalAgentAdapterRegistry();
		const gated = new FakeExternalAgentAdapter("gated-adapter");
		gated.probeSnapshot = readySnapshot("gated-adapter", "target-1", { cancel: "none" });
		registerFakeAdapter(registry2, gated, ["target-1"]);
		const { controller: controller2, records: records2, cleanup: cleanup2 } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry2,
		});
		try {
			await controller2.handleCommand({ id: "init-g", type: "initialize", protocolVersion: 1 });
			await controller2.handleCommand({
				id: "r2",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "gated-adapter", targetId: "target-1" },
			});
			const gateResponse = responsesFor(records2, "r2")[0];
			expect((gateResponse.error as { code: string }).code).toBe("external_agent_capability_missing");
			expect(terminalEvents(records2)).toHaveLength(0);
		} finally {
			await controller2.shutdown();
			await cleanup2();
		}
	});

	it("bounds a probe that hangs and ignores the abort signal, failing run.start with external_agent_probe_failed", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeHang = true;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-hang",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-hang")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_probe_failed");
			expect(adapter.probeCalls).toBe(1);
			expect(adapter.prepareCalls).toBe(0);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("bounds the probe by the requested Run deadline when it is earlier, failing run_deadline_exceeded", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeHang = true;
		registerFakeAdapter(registry, adapter);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			const deadlineAt = new Date(Date.now() + 1_000).toISOString();
			const startedAt = Date.now();
			await controller.handleCommand({
				id: "r-deadline-probe",
				type: "run.start",
				message: "hello",
				deadlineAt,
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-deadline-probe")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("run_deadline_exceeded");
			// The 1s Run deadline bound won over the 10s probe bound: a hanging
			// target must not consume the full probe window.
			expect(Date.now() - startedAt).toBeLessThan(8_000);
			expect(adapter.probeCalls).toBe(1);
			expect(adapter.prepareCalls).toBe(0);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("fails closed before preflight when the probed snapshot identity does not match the resolved explicit selection", async () => {
		// A snapshot self-reporting a different adapter than the resolved
		// selection must never enter preflight or acceptance.
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeSnapshot = readySnapshot("different-adapter", "target-1");
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-id-mismatch",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-id-mismatch")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_probe_failed");
			// The mismatched snapshot identity never leaks into the response.
			expect(JSON.stringify(response)).not.toContain("different-adapter");
			expect(adapter.probeCalls).toBe(1);
			expect(adapter.prepareCalls).toBe(0);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}

		// A target-id drift fails closed the same way.
		const registry2 = createExternalAgentAdapterRegistry();
		const targetDrift = new FakeExternalAgentAdapter();
		targetDrift.probeSnapshot = readySnapshot("test-adapter", "other-target");
		registerFakeAdapter(registry2, targetDrift);
		const { controller: controller2, records: records2, cleanup: cleanup2 } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry2,
		});
		try {
			await controller2.handleCommand({ id: "init2", type: "initialize", protocolVersion: 1 });
			await controller2.handleCommand({
				id: "r-target-mismatch",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records2, "r-target-mismatch")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_probe_failed");
			expect(JSON.stringify(response)).not.toContain("other-target");
			expect(targetDrift.probeCalls).toBe(1);
			expect(targetDrift.prepareCalls).toBe(0);
			expect(targetDrift.startCalls).toBe(0);
			expect(terminalEvents(records2)).toHaveLength(0);
		} finally {
			await controller2.shutdown();
			await cleanup2();
		}
	});

	it("persists external.mapping before run.started and settles through the Remote Operation ledger", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeSnapshot = readySnapshot("test-adapter", "target-1", { artifacts: true });
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent(), progressEvent(1, "planning"), artifactEvent()],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r3",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r3"), {
				outcome: "completed",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(completedReceipt());
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);

			const accepted = responsesFor(records, "r3")[0];
			expect(accepted).toMatchObject({ command: "run.start", success: true });
			const acceptedData = accepted.data as { runId: string; external: ExternalExecutionRef };
			expect(acceptedData.external).toEqual(externalRef());
			expect(runEventsOfType(records, "run.started")).toHaveLength(1);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });

			// Bounded events map to run.event records only (started/progress/artifact).
			const mappedEvents = externalAgentEvents(records);
			expect(mappedEvents.map((record) => (record.event as { event: ExternalAgentEvent }).event.type)).toEqual([
				"started",
				"progress",
				"artifact",
			]);

			// Mapping is appended before the started ledger fact.
			const entries = sessionManager.getEntries();
			const mappingIndex = entries.findIndex(
				(entry) => entry.type === "custom" && entry.customType === "external.mapping",
			);
			const startedIndex = entries.findIndex(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === RUN_LEDGER_CUSTOM_TYPE &&
					(entry.data as { kind?: string }).kind === "started",
			);
			expect(mappingIndex).toBeGreaterThanOrEqual(0);
			expect(startedIndex).toBeGreaterThan(mappingIndex);

			// The mapping carries the real external ref (flattened into the mapping
			// identity fields) and the adapter identity.
			const mappingEntries = customEntries(sessionManager, "external.mapping");
			const mapping = (mappingEntries[0].data as {
				mapping: { namespace: string; externalSessionId: string; adapter?: { adapterId: string } };
			}).mapping;
			expect(mapping.namespace).toBe("test-agent");
			expect(mapping.externalSessionId).toBe("ext-session-1");
			expect(mapping.adapter?.adapterId).toBe("test-adapter");

			// The Remote Operation ledger entry is recorded through startRemoteOperation
			// and carries the safe probed adapter identity (selection + verified
			// protocol), so the persisted receipt and Audit stay filterable by
			// adapter without any raw protocol or target data.
			const remoteEntries = customEntries(sessionManager, "remote.operation");
			expect(remoteEntries.length).toBe(1);
			const remoteReceipt = (remoteEntries[0].data as {
				receipt: {
					status: string;
					operationId: string;
					runId: string;
					adapter?: { adapterId: string; targetId: string; protocol: { name: string; version: string } };
				};
			}).receipt;
			expect(remoteReceipt).toMatchObject({
				status: "completed",
				operationId: acceptedData.runId,
				runId: acceptedData.runId,
				adapter: {
					adapterId: "test-adapter",
					targetId: "target-1",
					protocol: { name: "test-protocol", version: "1" },
				},
			});
			expect(JSON.stringify(sessionManager.getEntries())).not.toContain("secret");

			// The Audit query filters the persisted remote.operation receipt by adapter.
			const audit = new ExecutionAuditQuery(getAgentSessionLedger(getSession())).query({
				scope: "current-session",
				types: ["remote.operation"],
				adapter: { adapterId: "test-adapter", targetId: "target-1", protocol: { name: "test-protocol", version: "1" } },
			});
			expect(audit.events).toHaveLength(1);
			expect(audit.events[0]).toMatchObject({ type: "remote.operation", adapter: { adapterId: "test-adapter" } });

			// run.get exposes the external ref on the record and the receipt.
			await controller.handleCommand({ id: "r3-get", type: "run.get", runId: acceptedData.runId });
			const getData = (responsesFor(records, "r3-get")[0].data as {
				run: { external?: ExternalExecutionRef };
				receipt?: { runReceiptId?: string; status?: string; external?: ExternalExecutionRef };
			});
			expect(getData.run.external).toEqual(externalRef());
			expect(getData.receipt).toMatchObject({ runReceiptId: expect.any(String), status: "completed" });
			expect(getData.receipt).not.toHaveProperty("external");
			expect(adapter.probeCalls).toBe(1);
			expect(adapter.startCalls).toBe(1);
			expect(adapter.lastStartRequest?.input).toEqual({ message: "hello" });
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("wires run.cancel to the idempotent adapter cancel and settles cancelled", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r4",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			const accepted = responsesFor(records, "r4")[0];
			const runId = (accepted.data as { runId: string }).runId;

			const cancelCommand = controller.handleCommand({ id: "c4", type: "run.cancel", runId });
			await vi.waitFor(() => expect(handle.cancelCalls).toBeGreaterThanOrEqual(1));
			await writeCanonicalRunResult(getAgentCanonicalSession(getSession()), runId, {
				outcome: "cancelled",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(cancelledReceipt("none"));
			await cancelCommand;
			const cancelResponse = responsesFor(records, "c4")[0];
			expect(cancelResponse).toMatchObject({ command: "run.cancel", success: true });

			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			const terminal = terminalEvents(records)[0];
			expect(terminal.type).toBe("run.cancelled");
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
			const remoteReceipt = (
				customEntries(sessionManager, "remote.operation")[0].data as { receipt: { status: string; sideEffects: string } }
			).receipt;
			expect(remoteReceipt).toMatchObject({ status: "cancelled", sideEffects: "none" });
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("reaches the adapter when run.cancel arrives while start readiness is pending", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		adapter.start = async (request: ExternalAgentStartRequest, context: ExternalAgentExecutionContext) => {
			adapter.startCalls += 1;
			adapter.lastStartRequest = request;
			adapter.lastStartContext = context;
			await startGate;
			if (adapter.handle === undefined) throw new Error("no fake handle configured");
			return adapter.handle;
		};
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			// Do not await the start command: the accepted response is withheld until
			// start readiness resolves, so the command promise settles only after the
			// start gate below is released.
			const startPromise = controller.handleCommand({
				id: "r10",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			// The run is durably accepted but the accepted response is withheld until
			// start readiness resolves; the client can still cancel by runId from the
			// ledger, and the cancel must reach the adapter through the early
			// externalRuns registration instead of falling back to session.abort().
			await vi.waitFor(
				() => {
					const accepted = sessionManager
						.getEntries()
						.find(
							(entry) =>
								entry.type === "custom" &&
								entry.customType === RUN_LEDGER_CUSTOM_TYPE &&
								(entry.data as { kind?: string }).kind === "accepted",
						);
					expect(accepted).toBeDefined();
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(responsesFor(records, "r10")).toHaveLength(0);
			const acceptedEntry = sessionManager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === RUN_LEDGER_CUSTOM_TYPE &&
						(entry.data as { kind?: string }).kind === "accepted",
				)!;
			const runId = (
				(acceptedEntry as Extract<SessionEntry, { type: "custom" }>).data as { record: { id: string } }
			).record.id;

			await controller.handleCommand({ id: "c10", type: "run.cancel", runId });
			const cancelResponse = responsesFor(records, "c10")[0];
			expect(cancelResponse).toMatchObject({ command: "run.cancel", success: true });
			await writeCanonicalRunResult(sessionManager, runId, {
				outcome: "cancelled",
				completedAt: new Date().toISOString(),
			});

			releaseStart?.();
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			await startPromise;
			// The run started and then settled cancelled; the adapter cancel was
			// forwarded even though the cancel arrived before start readiness.
			expect(runEventsOfType(records, "run.started")).toHaveLength(1);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.cancelled" });
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("settles cancelled receipts with associated side effects as canonical failed side_effect_unknown", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent()],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r5",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r5"), {
				outcome: "failed",
				terminalErrorCode: "external_agent_side_effect_unknown",
				sideEffectState: "side_effect_unknown",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(cancelledReceipt("associated"));
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			const terminal = terminalEvents(records)[0];
			expect(terminal.type).toBe("run.failed");
			expect(runEventsOfType(records, "run.cancelled")).toHaveLength(0);
			const receipt = (terminal.receipt as { terminalError?: { code: string } });
			expect(receipt.terminalError?.code).toBe("side_effect_unknown");
			const remoteReceipt = (
				customEntries(sessionManager, "remote.operation")[0].data as {
					receipt: { status: string; sideEffects: string; error?: { category: string; retryable: boolean } };
				}
			).receipt;
			expect(remoteReceipt).toMatchObject({ status: "failed", sideEffects: "associated" });
			// The Remote Operation vocabulary keeps the small invalid category and
			// never retries; the canonical Run terminal carries side_effect_unknown.
			expect(remoteReceipt.error).toMatchObject({ category: "invalid", retryable: false });
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("settles the run at its deadline even when the adapter hangs, and cancels the adapter", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			// A sufficiently future canonical deadline: the start sequence always
			// completes before the deadline fires, so the run.started wait cannot
			// race the deadline. Whichever of the host deadline timer or the Remote
			// Operation request.deadlineAt mapping fires first, the accepted Run's
			// deadline intent wins: run.failed + run_deadline_exceeded, never
			// run.cancelled (the remote receipt deadline category is mapped in
			// trackExternalRun).
			const deadlineAt = new Date(Date.now() + 3_000).toISOString();
			await controller.handleCommand({
				id: "r6",
				type: "run.start",
				message: "hello",
				deadlineAt,
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r6"), {
				outcome: "failed",
				terminalErrorCode: "run_deadline_exceeded",
				completedAt: deadlineAt,
			});
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 10_000, interval: 20 },
			);
			const terminal = terminalEvents(records)[0];
			expect(terminal.type).toBe("run.failed");
			expect((terminal.receipt as { terminalError?: { code: string } }).terminalError?.code).toBe(
				"run_deadline_exceeded",
			);
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("invokes the trusted adapter.prepare and maps a raw prepare failure to external_agent_binding_unsupported without leaking detail", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.prepareError = new Error("raw provider credential sk-secret must never surface");
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-prepare",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-prepare")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_binding_unsupported");
			// Raw provider detail never reaches the response payload.
			expect(JSON.stringify(response)).not.toContain("sk-secret");
			expect(adapter.probeCalls).toBe(1);
			expect(adapter.prepareCalls).toBe(1);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("never forwards a raw message carried by a known automation code from adapter.prepare", async () => {
		const runPrepareSpoof = async (spoofed: unknown, id: string): Promise<void> => {
			// A fresh adapter and registry per case so the probe/prepare counters
			// assert the single invocation of this run only.
			const registry = createExternalAgentAdapterRegistry();
			const adapter = new FakeExternalAgentAdapter();
			registerFakeAdapter(registry, adapter);
			adapter.prepareError = spoofed;
			const { controller, records, sessionManager, cleanup } = await startInMemoryController({
				withAuth: true,
				responseDelayMs: 0,
				externalAgentRegistry: registry,
			});
			try {
				await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
				await controller.handleCommand({
					id,
					type: "run.start",
					message: "hello",
					externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
				});
				const response = responsesFor(records, id)[0];
				expect(response).toMatchObject({ command: "run.start", success: false });
				// The spoofed payload borrows a known automation code, but its raw
				// message must never surface: the prepare-phase fallback code and the
				// allowlisted code-derived message win.
				expect((response.error as { code: string }).code).toBe("external_agent_binding_unsupported");
				// The public wire always carries the generic redacted text; the raw
				// spoofed message must never surface anywhere in the payload.
				expect((response.error as { message: string }).message).toBe("Automation request failed.");
				expect(JSON.stringify(response)).not.toContain("sk-secret");
				expect(adapter.prepareCalls).toBe(1);
				expect(adapter.startCalls).toBe(0);
				expect(terminalEvents(records)).toHaveLength(0);
				expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
			} finally {
				await controller.shutdown();
				await cleanup();
			}
		};

		// A payload that borrows the lifecycle start_rejected code with a raw
		// message: the fixed-message allowlist rejects it and the phase fallback
		// wins.
		await runPrepareSpoof(
			{ code: "start_rejected", message: "sk-secret-credential", retryable: false },
			"r-spoof-rejected",
		);
		// A payload that borrows another known host code (session_busy) with a
		// raw message: the known-code branch must not forward the raw message
		// either.
		await runPrepareSpoof({ code: "session_busy", message: "sk-secret-credential", retryable: false }, "r-spoof-busy");
	});

	it("fails closed when the adapter rejects an unknown protocol during prepare", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.prepareError = new ExternalAgentError("external_agent_protocol_unsupported");
		registerFakeAdapter(registry, adapter);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-protocol",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-protocol")[0];
			expect((response.error as { code: string }).code).toBe("external_agent_protocol_unsupported");
			expect(adapter.prepareCalls).toBe(1);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("rejects a prepared binding that drifts from the probed protocol", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.prepareOverride = (request, snapshot) =>
			createExternalAgentPreparedBinding(request, {
				...snapshot,
				protocol: { name: "different-protocol", version: "9" },
			});
		registerFakeAdapter(registry, adapter);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-drift",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-drift")[0];
			expect((response.error as { code: string }).code).toBe("external_agent_binding_unsupported");
			expect(adapter.prepareCalls).toBe(1);
			expect(adapter.startCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("never enables tool-gateway from a target self-report and rejects a gateway prepared binding", async () => {
		// A target self-reporting toolGateway=true still runs reference-only
		// through the trusted prepare: no Host fallback and no AOS tool claims.
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeSnapshot = readySnapshot("test-adapter", "target-1", { toolGateway: true });
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-gw",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-gw"), {
				outcome: "completed",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(completedReceipt());
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(responsesFor(records, "r-gw")[0]).toMatchObject({ command: "run.start", success: true });
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });
			expect(adapter.prepareCalls).toBe(1);
			expect(adapter.startCalls).toBe(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}

		// An adapter that tries to hand back a tool-gateway prepared binding is
		// rejected: v1 has no independent gateway contract and the selection has
		// no explicit opt-in, so the run fails closed before acceptance.
		const registry2 = createExternalAgentAdapterRegistry();
		const gated = new FakeExternalAgentAdapter();
		gated.probeSnapshot = readySnapshot("test-adapter", "target-1", { toolGateway: true });
		gated.prepareOverride = (request, snapshot) =>
			createExternalAgentPreparedBinding(request, snapshot, { bindingMode: "tool-gateway" });
		registerFakeAdapter(registry2, gated);
		const { controller: controller2, records: records2, cleanup: cleanup2 } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry2,
		});
		try {
			await controller2.handleCommand({ id: "init2", type: "initialize", protocolVersion: 1 });
			await controller2.handleCommand({
				id: "r-gw2",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records2, "r-gw2")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_binding_unsupported");
			expect(gated.startCalls).toBe(0);
			expect(terminalEvents(records2)).toHaveLength(0);
		} finally {
			await controller2.shutdown();
			await cleanup2();
		}
	});

	it("fails closed when the caller-provided external ref conflicts with the adapter identity", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: completedReceipt(),
		});
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-ref-mismatch",
				type: "run.start",
				message: "hello",
				external: { namespace: "caller-ns", externalSessionId: "caller-session" },
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-ref-mismatch")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_mapping_invalid");
			// No started event and no mapping append for the drifted identity.
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("accepts a caller-provided external ref that matches the adapter identity", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-ref-match",
				type: "run.start",
				message: "hello",
				external: externalRef(),
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-ref-match"), {
				outcome: "completed",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(completedReceipt());
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			const accepted = responsesFor(records, "r-ref-match")[0];
			expect(accepted).toMatchObject({ command: "run.start", success: true });
			expect((accepted.data as { external: ExternalExecutionRef }).external).toEqual(externalRef());
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });
			const mapping = (customEntries(sessionManager, "external.mapping")[0].data as {
				mapping: { namespace: string; externalSessionId: string; externalRunId?: string };
			}).mapping;
			expect(mapping.namespace).toBe("test-agent");
			expect(mapping.externalSessionId).toBe("ext-session-1");
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("fails closed with external_agent_mapping_conflict when the adapter identity conflicts with append-only mapping history", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const firstHandle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
		});
		adapter.handle = firstHandle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-first",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-first"), {
				outcome: "completed",
				completedAt: new Date().toISOString(),
			});
			firstHandle.resolveReceipt(completedReceipt());
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });

			// The same external identity is bound append-only to the first run; a
			// second external run returning the same ref must fail closed.
			adapter.handle = new FakeExternalAgentHandle({
				external: externalRef(),
				events: [],
				receipt: completedReceipt(),
			});
			await controller.handleCommand({
				id: "r-second",
				type: "run.start",
				message: "hello again",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r-second")[0];
			expect(response).toMatchObject({ command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_mapping_conflict");
			expect(runEventsOfType(records, "run.started")).toHaveLength(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("fails the run closed with external_agent_persistence_failed when the remote.operation ledger append fails", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-ledger",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			// The remote.operation append at settlement fails durably; the run must
			// not report completed or cancelled on an unrecorded external outcome.
			// The spy throws only for the remote.operation custom entry so every
			// other append (run facts, cancellation intents) still succeeds, and it
			// is restored by the suite's afterEach restoreAllMocks.
			const sessionLedger = getAgentSessionLedger(getSession());
			const originalAppend = sessionLedger.appendCustomEntry.bind(sessionLedger);
			const appendSpy = vi.spyOn(sessionLedger, "appendCustomEntry").mockImplementation((customType, data) => {
				if (customType === "remote.operation") throw new Error("disk failure");
				return originalAppend(customType, data);
			});
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-ledger"), {
				outcome: "failed",
				terminalErrorCode: "external_agent_persistence_failed",
				completedAt: new Date().toISOString(),
			});
			// Settle the adapter with a plain failed receipt (no run.cancel intent)
			// so the ledger failure is the only failure path under test.
			handle.resolveReceipt(failedReceipt("external_agent_start_failed", "unknown"));
			await vi.waitFor(
				() => {
					expect(appendSpy).toHaveBeenCalledWith("remote.operation", expect.anything());
				},
				{ timeout: 5000, interval: 20 },
			);
			const terminal = terminalEvents(records)[0];
			expect(terminal).toMatchObject({
				type: "run.failed",
				receipt: {
					runReceiptId: expect.any(String),
					terminalError: { code: "external_agent_persistence_failed" },
				},
			});
			expect(runEventsOfType(records, "run.cancelled")).toHaveLength(0);
			expect(customEntries(sessionManager, "remote.operation")).toHaveLength(0);
			await controller.handleCommand({ id: "r-ledger-get", type: "run.get", runId: responseRunId(records, "r-ledger") });
			const getResponse = responsesFor(records, "r-ledger-get")[0];
			expect(getResponse).toMatchObject({
				success: true,
				data: {
					run: { status: "failed" },
					receipt: { status: "failed", terminalError: { code: "external_agent_persistence_failed" } },
				},
			});
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("rejects external run.resume with external_agent_resume_unsupported and never probes", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		registerFakeAdapter(registry, adapter);
		const { controller, records, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r7",
				type: "run.resume",
				sessionPath: "/nonexistent/session.jsonl",
				sourceRunId: "run:source",
				message: "resume me",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const response = responsesFor(records, "r7")[0];
			expect(response).toMatchObject({ command: "run.resume", success: false });
			expect((response.error as { code: string }).code).toBe("external_agent_resume_unsupported");
			expect(adapter.probeCalls).toBe(0);
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("preserves the default local path when no external agent selection is present", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({ id: "r9", type: "run.start", message: "Hello" });
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });
			expect(runEventsOfType(records, "run.started")).toHaveLength(1);
			// The local path never touches the adapter and records no mapping.
			expect(adapter.probeCalls).toBe(0);
			expect(adapter.startCalls).toBe(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("forwards the Run cancellation intent to the adapter on transport detach and settles the started external run cancelled", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-detach",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-detach"), {
				outcome: "cancelled",
				completedAt: new Date().toISOString(),
			});

			// Detach forwards the Run cancellation intent to the adapter's
			// idempotent cancel path and awaits the tracked settlement, so the
			// terminal is durably recorded through the same Run/Remote Operation
			// gates before the transport is released.
			await controller.detachTransport();
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.cancelled" });
			expect(runEventsOfType(records, "run.failed")).toHaveLength(0);
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
			// The Remote Operation receipt lands in the same Session ledger.
			await vi.waitFor(
				() => {
					expect(customEntries(sessionManager, "remote.operation")).toHaveLength(1);
				},
				{ timeout: 5000, interval: 20 },
			);
			const remoteReceipt = (
				customEntries(sessionManager, "remote.operation")[0].data as {
					receipt: { status: string; sideEffects: string };
				}
			).receipt;
			expect(remoteReceipt).toMatchObject({ status: "cancelled", sideEffects: "none" });
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("unblocks a pending external start on detach and fails it closed without hanging", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		adapter.start = async (request: ExternalAgentStartRequest, context: ExternalAgentExecutionContext) => {
			adapter.startCalls += 1;
			adapter.lastStartRequest = request;
			adapter.lastStartContext = context;
			await startGate;
			if (adapter.handle === undefined) throw new Error("no fake handle configured");
			return adapter.handle;
		};
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			const startPromise = controller.handleCommand({
				id: "r-detach-pending",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(
						sessionManager
							.getEntries()
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === RUN_LEDGER_CUSTOM_TYPE &&
									(entry.data as { kind?: string }).kind === "accepted",
							),
					).toBe(true);
				},
				{ timeout: 5000, interval: 20 },
			);

			// The accepted-but-not-started run must not block the detach: the
			// deadline controller abort resolves the readiness race even though
			// adapter.start never returned, and the start fails closed with the
			// connection-closed rejection (never run_deadline_exceeded).
			await controller.detachTransport();
			await startPromise;
			const startResponse = responsesFor(records, "r-detach-pending")[0];
			expect(startResponse).toMatchObject({ command: "run.start", success: false });
			expect((startResponse.error as { code: string }).code).toBe("start_rejected");
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);

			// The adapter cancel is forwarded once the driver's start gate is
			// released (the driver awaits adapter.start before forwarding).
			releaseStart?.();
			await startPromise;
			await vi.waitFor(
				() => {
					expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
				},
				{ timeout: 5000, interval: 20 },
			);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("forwards the Run cancellation intent to the adapter on host shutdown and settles the started external run cancelled", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, runtimeHost, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-shutdown",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-shutdown"), {
				outcome: "cancelled",
				completedAt: new Date().toISOString(),
			});

			await controller.shutdown();
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.cancelled" });
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
			const disposeSpy = runtimeHost.dispose as unknown as ReturnType<typeof vi.fn>;
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("fails a preflight-phase pending external start closed on host shutdown without accepting", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			// Hold the run in the signal-aware preflight phase: the lifecycle
			// abort must reject it, and the start must fail closed with the
			// shutdown rejection BEFORE any accept or adapter start.
			const session = getSession();
			vi.spyOn(session, "runExternalAgentPreflight").mockImplementation(
				async (_runId?: string, signal?: AbortSignal) => {
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("preflight aborted")), { once: true });
					});
				},
			);
			const startPromise = controller.handleCommand({
				id: "r-shutdown-pending",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(adapter.startCalls).toBe(0);
				},
				{ timeout: 5000, interval: 20 },
			);

			// Shutdown aborts the preflight-phase start and must not hang on it.
			await controller.shutdown();
			await startPromise;
			const startResponse = responsesFor(records, "r-shutdown-pending")[0];
			expect(startResponse).toMatchObject({ command: "run.start", success: false });
			expect((startResponse.error as { code: string }).code).toBe("start_rejected");
			// No accept, no started event, no terminal, and the adapter was never
			// started: the preflight-phase start cannot continue after shutdown.
			expect(customEntries(sessionManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);
			expect(adapter.startCalls).toBe(0);
			expect(handle.cancelCalls).toBe(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("does not block detach on a preflight-phase external start that ignores the abort signal", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: completedReceipt(),
		});
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			// Preflight ignores the abort signal entirely (never resolves): the
			// detach must still return promptly instead of awaiting the pending
			// start, and the continuation must never accept or start.
			const session = getSession();
			vi.spyOn(session, "runExternalAgentPreflight").mockImplementation(async () => {
				await new Promise<void>(() => {});
			});
			void controller.handleCommand({
				id: "r-detach-preflight",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(adapter.startCalls).toBe(0);
				},
				{ timeout: 5000, interval: 20 },
			);

			await controller.detachTransport();
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);
			// The ignored abort means the run was never accepted: nothing to
			// recover, nothing written.
			expect(customEntries(sessionManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(customEntries(sessionManager, "external.mapping")).toHaveLength(0);
			expect(adapter.startCalls).toBe(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("does not block a session switch on a preflight-phase external start that ignores the abort signal", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		adapter.handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: completedReceipt(),
		});
		registerFakeAdapter(registry, adapter);
		const { controller, runtimeHost, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			const session = getSession();
			vi.spyOn(session, "runExternalAgentPreflight").mockImplementation(async () => {
				await new Promise<void>(() => {});
			});
			void controller.handleCommand({
				id: "r-switch-preflight",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(adapter.startCalls).toBe(0);
				},
				{ timeout: 5000, interval: 20 },
			);

			// The switch must not await the abort-ignoring pending start; the
			// generation guard keeps its continuation from accepting or writing.
			const targetDir = join(tmpdir(), `aos-external-agent-switch-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const switchPath = SessionManager.create(targetDir).getSessionFile()!;
			await runtimeHost.switchSession(switchPath);
			const incomingManager = getSession().sessionRead;
			expect(customEntries(incomingManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(customEntries(incomingManager, "remote.operation")).toHaveLength(0);
			expect(customEntries(incomingManager, "external.mapping")).toHaveLength(0);
			expect(customEntries(sessionManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("forwards the Run cancellation intent to the adapter on session switch and settles into the outgoing session's ledger only", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, runtimeHost, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "r-switch",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(runEventsOfType(records, "run.started").length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			await writeCanonicalRunResult(sessionManager, responseRunId(records, "r-switch"), {
				outcome: "cancelled",
				completedAt: new Date().toISOString(),
			});

			const targetDir = join(tmpdir(), `aos-external-agent-switch-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const switchPath = SessionManager.create(targetDir).getSessionFile()!;
			// The switch_session command is a host-mutating command that is
			// rejected after initialize; embedders replace the session through
			// the runtime, which commits the Host's prepared replacement binding.
			await runtimeHost.switchSession(switchPath);

			// The started run settles cancelled through the existing gates, and
			// the terminal plus the Remote Operation receipt stay in the outgoing
			// session's ledger.
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.cancelled" });
			expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
			await vi.waitFor(
				() => {
					expect(customEntries(sessionManager, "remote.operation")).toHaveLength(1);
				},
				{ timeout: 5000, interval: 20 },
			);
			const remoteReceipt = (
				customEntries(sessionManager, "remote.operation")[0].data as {
					receipt: { status: string };
				}
			).receipt;
			expect(remoteReceipt.status).toBe("cancelled");

			// The incoming session's ledger must stay clean: no Run records, no
			// Remote Operation receipt, and no external mapping.
			const incomingManager = getSession().sessionRead;
			expect(customEntries(incomingManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(customEntries(incomingManager, "remote.operation")).toHaveLength(0);
			expect(customEntries(incomingManager, "external.mapping")).toHaveLength(0);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("fails a pending external start closed on session switch without writing into the incoming session", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receiptOnCancel: cancelledReceipt("none"),
		});
		adapter.handle = handle;
		adapter.start = async (request: ExternalAgentStartRequest, context: ExternalAgentExecutionContext) => {
			adapter.startCalls += 1;
			adapter.lastStartRequest = request;
			adapter.lastStartContext = context;
			await startGate;
			if (adapter.handle === undefined) throw new Error("no fake handle configured");
			return adapter.handle;
		};
		registerFakeAdapter(registry, adapter);
		const { controller, runtimeHost, records, sessionManager, getSession, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			const startPromise = controller.handleCommand({
				id: "r-switch-pending",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			await vi.waitFor(
				() => {
					expect(
						sessionManager
							.getEntries()
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === RUN_LEDGER_CUSTOM_TYPE &&
									(entry.data as { kind?: string }).kind === "accepted",
							),
					).toBe(true);
				},
				{ timeout: 5000, interval: 20 },
			);

			// The switch does not await the pending external start; it fails
			// closed on the session-generation guard before the incoming session
			// is assigned.
			const targetDir = join(tmpdir(), `aos-external-agent-switch-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const switchPath = SessionManager.create(targetDir).getSessionFile()!;
			await runtimeHost.switchSession(switchPath);
			// The pending start is not awaited by the switch (an abort-ignoring
			// start must not block it); its continuation fails closed on the
			// generation guard.
			await startPromise;
			const startResponse = responsesFor(records, "r-switch-pending")[0];
			expect(startResponse).toMatchObject({ command: "run.start", success: false });
			expect((startResponse.error as { code: string }).code).toBe("start_rejected");

			// No started event and no terminal: the accepted record replays as
			// interrupted in the outgoing session, and nothing lands in the
			// incoming session's ledger.
			expect(runEventsOfType(records, "run.started")).toHaveLength(0);
			expect(terminalEvents(records)).toHaveLength(0);
			const incomingManager = getSession().sessionRead;
			expect(customEntries(incomingManager, RUN_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
			expect(customEntries(incomingManager, "remote.operation")).toHaveLength(0);
			expect(customEntries(incomingManager, "external.mapping")).toHaveLength(0);

			releaseStart?.();
			await vi.waitFor(
				() => {
					expect(handle.cancelCalls).toBeGreaterThanOrEqual(1);
				},
				{ timeout: 5000, interval: 20 },
			);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("lets a Task Graph node attach and settle an Adapter Run without the Adapter starting or queuing nodes", async () => {
		const registry = createExternalAgentAdapterRegistry();
		const adapter = new FakeExternalAgentAdapter();
		const handle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent()],
		});
		adapter.handle = handle;
		registerFakeAdapter(registry, adapter);
		const { controller, records, sessionManager, cleanup } = await startInMemoryController({
			withAuth: true,
			responseDelayMs: 0,
			externalAgentRegistry: registry,
		});

		try {
			await controller.handleCommand({ id: "init", type: "initialize", protocolVersion: 1 });
			await controller.handleCommand({
				id: "graph-create",
				type: "task.graph.create",
				taskId: "task_adapter",
				graphRevision: 1,
				nodes: [
					{ nodeId: "inspect", dependsOn: [] },
					{ nodeId: "review", dependsOn: ["inspect"] },
				],
				clientRequestId: "graph-create-adapter",
			});
			const created = responsesFor(records, "graph-create")[0];
			expect(created).toMatchObject({ command: "task.graph.create", success: true });
			expect(adapter.startCalls).toBe(0);

			await controller.handleCommand({
				id: "r-graph",
				type: "run.start",
				message: "hello",
				externalAgent: { adapterId: "test-adapter", targetId: "target-1" },
			});
			const accepted = responsesFor(records, "r-graph")[0];
			expect(accepted).toMatchObject({ command: "run.start", success: true });
			const runId = (accepted.data as { runId: string }).runId;
			expect(adapter.startCalls).toBe(1);

			await controller.handleCommand({
				id: "graph-attach",
				type: "task.graph.node.attach",
				taskId: "task_adapter",
				graphRevision: 1,
				nodeId: "inspect",
				runId,
				clientRequestId: "graph-attach-adapter",
			});
			const attached = responsesFor(records, "graph-attach")[0];
			expect(attached).toMatchObject({ command: "task.graph.node.attach", success: true });
			expect((attached.data as { node?: { status?: string; availability?: unknown } }).node).toMatchObject({
				status: "running",
				availability: null,
			});
			// The Adapter does not auto-start the dependent node.
			expect(adapter.startCalls).toBe(1);

			await writeCanonicalRunResult(sessionManager, runId, {
				outcome: "completed",
				completedAt: new Date().toISOString(),
			});
			handle.resolveReceipt(completedReceipt());
			await vi.waitFor(
				() => {
					expect(terminalEvents(records).length).toBeGreaterThan(0);
				},
				{ timeout: 5000, interval: 20 },
			);
			expect(terminalEvents(records)[0]).toMatchObject({ type: "run.completed" });

			await controller.handleCommand({
				id: "graph-settle",
				type: "task.graph.node.settle",
				taskId: "task_adapter",
				graphRevision: 1,
				nodeId: "inspect",
				clientRequestId: "graph-settle-adapter",
			});
			const settled = responsesFor(records, "graph-settle")[0];
			expect(settled).toMatchObject({ command: "task.graph.node.settle", success: true });
			expect((settled.data as { node?: { status?: string } }).node).toMatchObject({ status: "succeeded" });
			expect((settled.data as { graph?: { nodes?: Array<{ nodeId: string; status: string }> } }).graph?.nodes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ nodeId: "inspect", status: "succeeded" }),
					expect.objectContaining({ nodeId: "review", status: "pending" }),
				]),
			);
			expect(adapter.startCalls).toBe(1);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});
});
