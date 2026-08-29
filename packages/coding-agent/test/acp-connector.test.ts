import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	AGENT_METHODS,
	CLIENT_METHODS,
	PROTOCOL_VERSION,
	agent,
	ndJsonStream,
	type AgentApp,
	type AgentNotificationContext,
	type AgentRequestContext,
	type InitializeRequest,
	type InitializeResponse,
	type LoadSessionRequest,
	type NewSessionRequest,
	type PromptRequest,
	type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
	InMemorySessionStorage,
	Session,
	SessionLedger,
	ContextLedger,
	TOOL_EXECUTION_RESULT_MAX_BYTES,
	createConnectorCapabilitySnapshot,
	validateToolExecutionResult,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type ToolExecutionResult,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import * as packageEntry from "../src/index.ts";
import {
	getHostSupervisedExternalAgentConnectorImplementation,
	isHostSupervisedExternalAgentConnector,
} from "../src/core/connector/durable-connector.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/connector/operation.ts";
import { classifyExternalToolPolicyOperation } from "../src/core/connector/tool-policy.ts";
import { classifyProtectedPathOperation } from "../src/core/policy/protected-path.ts";
import type { CanonicalExternalConnectorMapping } from "../src/core/connector/session-mapping.ts";
import {
	PrivateAcpStableV1Driver,
	createPrivateAcpExternalAgentConnector,
	type PrivateAcpStableV1DriverOptions,
	type PrivateAcpStableV1TransportFactory,
} from "../src/core/connector/vendor/acp.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverSpawnRequest,
} from "../src/core/connector/vendor/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const now = "2026-08-28T00:00:00.000Z";
const providerId = "private-acp-fixture";
const sessionId = "acp-session-1";

const attempt: Attempt = {
	schemaVersion: 1,
	attemptId: "attempt-acp-1",
	dispatchId: "dispatch-acp-1",
	taskId: "task-acp-1",
	providerId,
	bindingId: "binding-acp-1",
	bindingEpochIds: ["binding-epoch-acp-1"],
	status: "starting",
	startedAt: now,
};

const correlation: ExecutionCorrelation = {
	sessionId: "host-session-acp-1",
	laneId: "main",
	revision: 1,
	runId: "run-acp-1",
	operationId: "run-acp-1",
	taskId: attempt.taskId,
	dispatchId: attempt.dispatchId,
	attemptId: attempt.attemptId,
	bindingId: attempt.bindingId,
	bindingEpochId: attempt.bindingEpochIds[0],
	providerId,
};

const capability: ConnectorCapabilitySnapshot = createConnectorCapabilitySnapshot({
	schemaVersion: 1,
	providerId,
	revision: 1,
	protocol: { name: "acp", version: "1" },
	modelAccess: "agent_owned",
	resume: true,
	toolGateway: true,
	artifacts: false,
	images: false,
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "aos-acp-"));
	temporaryDirectories.push(directory);
	return directory;
}

interface RawStreamPair {
	readonly clientInput: ReadableStream<Uint8Array>;
	readonly clientOutput: WritableStream<Uint8Array>;
	readonly agentInput: ReadableStream<Uint8Array>;
	readonly agentOutput: WritableStream<Uint8Array>;
}

function rawStreamPair(): RawStreamPair {
	const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
	const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
	return {
		clientInput: agentToClient.readable,
		clientOutput: clientToAgent.writable,
		agentInput: clientToAgent.readable,
		agentOutput: agentToClient.writable,
	};
}

interface FakeAgentState {
	readonly initializeRequests: InitializeRequest[];
	readonly newSessionRequests: NewSessionRequest[];
	readonly loadSessionRequests: LoadSessionRequest[];
	cancelNotifications: number;
}

interface FakeAgentOptions {
	readonly initializeResponse?: InitializeResponse;
	readonly onPrompt?: (context: AgentRequestContext<PromptRequest>) => Promise<PromptResponse>;
	readonly onCancel?: (context: AgentNotificationContext<{ readonly sessionId: string }>) => void | Promise<void>;
}

function fakeAgent(options: FakeAgentOptions = {}): { readonly app: AgentApp; readonly state: FakeAgentState } {
	const state: FakeAgentState = {
		initializeRequests: [],
		newSessionRequests: [],
		loadSessionRequests: [],
		cancelNotifications: 0,
	};
	const app = agent({ name: "aos-acp-test-agent" })
		.onRequest(AGENT_METHODS.initialize, ({ params }) => {
			state.initializeRequests.push(params);
			return options.initializeResponse ?? {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true },
			};
		})
		.onRequest(AGENT_METHODS.session_new, ({ params }) => {
			state.newSessionRequests.push(params);
			return { sessionId };
		})
		.onRequest(AGENT_METHODS.session_load, ({ params }) => {
			state.loadSessionRequests.push(params);
			return {};
		})
		.onRequest(AGENT_METHODS.session_prompt, (context) =>
			options.onPrompt?.(context) ?? Promise.resolve({ stopReason: "end_turn" }),
		)
		.onNotification(AGENT_METHODS.session_cancel, async (context) => {
			state.cancelNotifications += 1;
			await options.onCancel?.(context);
		});
	return { app, state };
}

function transportFactory(
	app: AgentApp,
	onOpen?: () => void,
	onConnection?: (close: (error?: unknown) => void) => void,
): PrivateAcpStableV1TransportFactory {
	return async () => {
		onOpen?.();
		const pair = rawStreamPair();
		const connection = app.connect(ndJsonStream(pair.agentOutput, pair.agentInput));
		onConnection?.((error?: unknown) => {
			connection.close(error);
			const writer = pair.agentOutput.getWriter();
			void writer.abort(error).finally(() => writer.releaseLock());
		});
		return {
			input: pair.clientInput,
			output: pair.clientOutput,
			close: (error?: unknown) => connection.close(error),
		};
	};
}

function driverOptions(
	cwd: string,
	factory: PrivateAcpStableV1TransportFactory,
	overrides: Partial<PrivateAcpStableV1DriverOptions> = {},
): PrivateAcpStableV1DriverOptions {
	return {
		providerId,
		transportFactory: factory,
		cwd,
		roots: { workspace: cwd },
		now: () => now,
		...overrides,
	};
}

function spawnRequest(overrides: Partial<ExternalConnectorDriverSpawnRequest> = {}): ExternalConnectorDriverSpawnRequest {
	return {
		attempt,
		correlation,
		input: { schemaVersion: 1, text: "Perform the ACP fixture task", artifacts: [] },
		capability,
		bindingDigest: "a".repeat(64),
		bindingRevision: 1,
		supervisorRef: "supervisor-acp-1",
		operationNonce: "nonce-acp-1",
		...overrides,
	};
}

function mapping(): CanonicalExternalConnectorMapping {
	return {
		schemaVersion: 1,
		providerId,
		attemptId: attempt.attemptId,
		externalSessionId: sessionId,
		externalTurnId: attempt.attemptId,
		binding: { digest: { algorithm: "sha256", value: "a".repeat(64) }, revision: 1 },
		capability: { digest: capability.digest, revision: capability.revision },
		supervisor: { ref: "supervisor-acp-1", nonce: "nonce-acp-1" },
		createdAt: now,
	};
}

async function nextDriverEvent(
	iterator: AsyncIterator<FoundationJsonValue>,
): Promise<ExternalConnectorDriverEvent> {
	const next = await iterator.next();
	if (next.done) throw new Error("ACP event stream ended early");
	return next.value as unknown as ExternalConnectorDriverEvent;
}

async function nextToolEvent(
	iterator: AsyncIterator<FoundationJsonValue>,
): Promise<Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>> {
	for (;;) {
		const event = await nextDriverEvent(iterator);
		if (event.type === "tool_gateway_request") return event;
	}
}

function successfulToolResult(
	event: Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>,
	result?: FoundationJsonValue,
	toolReceiptRef?: string,
	sideEffectState: ToolExecutionResult["sideEffectState"] = "none",
): ToolExecutionResult {
	return {
		schemaVersion: 1,
		toolCallId: event.request.toolCallId,
		toolName: event.request.toolName,
		ok: true,
		sideEffectState,
		...(result === undefined ? {} : { result }),
		...(toolReceiptRef === undefined ? {} : { toolReceiptRef }),
	};
}

async function settleTool(
	driver: PrivateAcpStableV1Driver,
	handle: ExternalConnectorDriverHandle,
	event: Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>,
	result?: FoundationJsonValue,
	toolReceiptRef?: string,
	sideEffectState?: ToolExecutionResult["sideEffectState"],
): Promise<void> {
	await driver.write(handle, {
		schemaVersion: 1,
		kind: "tool_gateway_result",
		operationNonce: handle.operationNonce,
		result: successfulToolResult(event, result, toolReceiptRef, sideEffectState),
	});
}

function rawProtocolTransport(
	mode: "malformed" | "oversize",
): PrivateAcpStableV1TransportFactory {
	return async () => {
		const pair = rawStreamPair();
		const agentStream = ndJsonStream(pair.agentOutput, pair.agentInput);
		void (async () => {
			const reader = agentStream.readable.getReader();
			const writer = pair.agentOutput.getWriter();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) return;
					const message = next.value;
					if (!("method" in message) || !("id" in message)) continue;
					if (message.method === AGENT_METHODS.initialize) {
						await writer.write(new TextEncoder().encode(`${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
						})}\n`));
					} else if (message.method === AGENT_METHODS.session_new) {
						await writer.write(new TextEncoder().encode(`${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { sessionId },
						})}\n`));
					} else if (message.method === AGENT_METHODS.session_prompt) {
						const update = {
							jsonrpc: "2.0",
							method: CLIENT_METHODS.session_update,
							params: {
								sessionId,
								update: {
									sessionUpdate: "agent_message_chunk",
									content: { type: "text", text: mode === "oversize" ? "x".repeat(4_096) : "x" },
								},
							},
							...(mode === "malformed" ? { unexpected: true } : {}),
						};
						await writer.write(new TextEncoder().encode(`${JSON.stringify(update)}\n`));
						await writer.write(new TextEncoder().encode(`${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { stopReason: "end_turn" },
						})}\n`));
					}
				}
			} catch {
				// The bounded client closes the fixture stream on the expected failure.
			} finally {
				reader.releaseLock();
				writer.releaseLock();
			}
		})();
		return { input: pair.clientInput, output: pair.clientOutput, close: () => undefined };
	};
}

describe("private ACP stable-v1 connector driver", () => {
	it("runs stable initialize, session/new, update, permission, filesystem, terminal, and prompt through one driver", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "result.txt");
		const selectedMcpServer = {
			type: "http" as const,
			name: "selected-tools",
			url: "https://mcp.example.test/rpc",
			headers: [{ name: "X-Scope", value: "selected" }],
		};
		let permissionOutcome: unknown;
		let terminalId: string | undefined;
		let terminalOutput: unknown;
		let terminalExit: unknown;
		const fixture = fakeAgent({
			initializeResponse: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
			},
			onPrompt: async ({ client }) => {
				await client.notify(CLIENT_METHODS.session_update, {
					sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
					_meta: { "aos.sequence": 1 },
				});
				permissionOutcome = await client.request(CLIENT_METHODS.session_request_permission, {
					sessionId,
					toolCall: { toolCallId: "permission-1", title: "write", kind: "edit" },
					options: [
						{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
						{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
					],
				});
				await client.request(CLIENT_METHODS.fs_write_text_file, {
					sessionId,
					path: target,
					content: "done",
				});
				const terminal = await client.request(CLIENT_METHODS.terminal_create, {
					sessionId,
					command: "node",
					args: ["--version"],
					cwd,
				});
				terminalId = terminal.terminalId;
				terminalOutput = await client.request(CLIENT_METHODS.terminal_output, {
					sessionId,
					terminalId: terminal.terminalId,
				});
				terminalExit = await client.request(CLIENT_METHODS.terminal_wait_for_exit, {
					sessionId,
					terminalId: terminal.terminalId,
				});
				return { stopReason: "end_turn" };
			},
		});
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app), {
			mcpServers: [selectedMcpServer],
		}));
		const handle = await driver.spawn(spawnRequest());
		const iterator = driver.events(handle)[Symbol.asyncIterator]();

		expect(await nextDriverEvent(iterator)).toMatchObject({ type: "started", externalSessionId: sessionId });
		expect(await nextDriverEvent(iterator)).toMatchObject({ type: "progress", sequence: 1 });
		const permission = await nextToolEvent(iterator);
		expect(permission.request).toMatchObject({ namespace: "acp", toolName: "acp.permission.request" });
		await settleTool(driver, handle, permission, { optionId: "allow-once" }, "permission-receipt");
		const write = await nextToolEvent(iterator);
		expect(write.request).toMatchObject({ namespace: "acp", toolName: "acp.fs.write_text_file" });
		expect(write.request.originalArguments).toMatchObject({ path: await realpath(cwd).then((root) => path.join(root, "result.txt")) });
		await settleTool(driver, handle, write);
		const terminal = await nextToolEvent(iterator);
		expect(terminal.request).toMatchObject({
			namespace: "acp",
			toolName: "acp.terminal.create",
			originalArguments: { command: "node", args: ["--version"], env: [] },
		});
		await settleTool(driver, handle, terminal, { terminalId: "terminal-1" }, "terminal-create-receipt");
		const output = await nextToolEvent(iterator);
		expect(output.request).toMatchObject({
			namespace: "acp",
			toolName: "acp.terminal.output",
			originalArguments: { terminalId: "terminal-1" },
		});
		await settleTool(driver, handle, output, {
			output: "v1.2.3",
			truncated: true,
			exitStatus: { exitCode: 0 },
		}, "terminal-output-receipt");
		const wait = await nextToolEvent(iterator);
		expect(wait.request).toMatchObject({
			namespace: "acp",
			toolName: "acp.terminal.wait_for_exit",
			originalArguments: { terminalId: "terminal-1" },
		});
		await settleTool(driver, handle, wait, { exitCode: 0, signal: null }, "terminal-wait-receipt");

		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded", sideEffectState: "none" });
		expect(permissionOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
		expect(terminalId).toBe("terminal-1");
		expect(terminalOutput).toEqual({ output: "v1.2.3", truncated: true, exitStatus: { exitCode: 0 } });
		expect(terminalExit).toEqual({ exitCode: 0, signal: null });
		expect(fixture.state.initializeRequests).toEqual([
			expect.objectContaining({ protocolVersion: 1 }),
		]);
		expect(fixture.state.newSessionRequests).toEqual([
			expect.objectContaining({ cwd: await realpath(cwd), mcpServers: [selectedMcpServer] }),
		]);
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
		await driver.dispose();
	});

	it("rejects non-JSON and oversized structured Tool Gateway results", () => {
		const base = {
			schemaVersion: 1 as const,
			toolCallId: "bounded-result",
			toolName: "acp.terminal.output",
			ok: true,
			sideEffectState: "none" as const,
		};
		expect(validateToolExecutionResult({ ...base, result: { output: BigInt(1) } }).ok).toBe(false);
		expect(validateToolExecutionResult({
			...base,
			result: { output: "x".repeat(TOOL_EXECUTION_RESULT_MAX_BYTES + 1) },
		}).ok).toBe(false);
	});

	it("settles a rejected permission gateway request as cancelled", async () => {
		const cwd = await workspace();
		let resolvePermission: ((value: unknown) => void) | undefined;
		const permission = new Promise<unknown>((resolve) => {
			resolvePermission = resolve;
		});
		const fixture = fakeAgent({
			onPrompt: async ({ client }) => {
				resolvePermission?.(await client.request(CLIENT_METHODS.session_request_permission, {
					sessionId,
					toolCall: { toolCallId: "permission-timeout", title: "write", kind: "edit" },
					options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
				}));
				return { stopReason: "end_turn" };
			},
		});
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app), {
			limits: { requestTimeoutMs: 250 },
		}));
		const handle = await driver.spawn(spawnRequest({ operationNonce: "nonce-permission-timeout" }));
		const iterator = driver.events(handle)[Symbol.asyncIterator]();
		expect((await nextDriverEvent(iterator)).type).toBe("started");
		expect((await nextToolEvent(iterator)).request.toolName).toBe("acp.permission.request");
		await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
		await expect(driver.read(handle)).rejects.toMatchObject({ code: "external_resource_limit_exceeded" });
		await driver.dispose();
	}, 2_000);

	it("loads a stable mapped session on resume and reports crash reconciliation as ambiguous", async () => {
		const cwd = await workspace();
		const fixture = fakeAgent();
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
		expect(await driver.lookup(mapping())).toEqual({ status: "ambiguous" });

		const handle = await driver.connect(mapping());
		const iterator = driver.events(handle)[Symbol.asyncIterator]();
		expect(await nextDriverEvent(iterator)).toMatchObject({ type: "started", externalSessionId: sessionId });
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "suspended", sideEffectState: "unknown" });
		expect(fixture.state.loadSessionRequests).toEqual([
			expect.objectContaining({ sessionId, cwd: await realpath(cwd), mcpServers: [] }),
		]);
		await expect(driver.lookup(mapping())).resolves.toMatchObject({ status: "terminal" });
		await driver.dispose();
	});

	it("reports an active transport crash as ambiguous for durable reconciliation", async () => {
		const cwd = await workspace();
		let crash: ((error?: unknown) => void) | undefined;
		const fixture = fakeAgent({
			onPrompt: () => new Promise<PromptResponse>(() => undefined),
		});
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(
			fixture.app,
			undefined,
			(close) => {
				crash = close;
			},
		)));
		const handle = await driver.spawn(spawnRequest());
		crash?.(new Error("fixture crash"));
		await expect(driver.read(handle)).rejects.toMatchObject({ code: "external_event_invalid" });
		await expect(driver.lookup(mapping())).resolves.toEqual({ status: "ambiguous" });
		await driver.dispose();
	});

	it("cancels before, during, and after a routed side effect without inventing terminal authority", async () => {
		for (const phase of ["before", "pending", "after"] as const) {
			const cwd = await workspace();
			let completeCancellation: (() => void) | undefined;
			const cancelled = new Promise<void>((resolve) => {
				completeCancellation = resolve;
			});
			const fixture = fakeAgent({
				onPrompt: async ({ client }) => {
					if (phase !== "before") {
						try {
							await client.request(CLIENT_METHODS.fs_write_text_file, {
								sessionId,
								path: path.join(cwd, "cancelled.txt"),
								content: "effect",
							});
						} catch (error) {
							if (phase !== "pending") throw error;
						}
					}
					await cancelled;
					return { stopReason: "cancelled" };
				},
				onCancel: () => completeCancellation?.(),
			});
			const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-${phase}` }));
			if (phase !== "before") {
				const iterator = driver.events(handle)[Symbol.asyncIterator]();
				expect((await nextDriverEvent(iterator)).type).toBe("started");
				const effect = await nextToolEvent(iterator);
				if (phase === "after") {
					await settleTool(driver, handle, effect, undefined, undefined, "side_effect_unknown");
				}
			}
			await expect(driver.cancel(handle)).resolves.toMatchObject({
				status: "cancelled",
				sideEffectState: phase === "before" ? "none" : "side_effect_unknown",
			});
			expect(fixture.state.cancelNotifications).toBe(1);
			await driver.dispose();
		}
	});

	it("fails closed on duplicate and out-of-order ACP update sequences", async () => {
		for (const sequences of [[2, 2], [3, 2]]) {
			const cwd = await workspace();
			const fixture = fakeAgent({
				onPrompt: async ({ client }) => {
					for (const sequence of sequences) {
						await client.notify(CLIENT_METHODS.session_update, {
							sessionId,
							update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
							_meta: { "aos.sequence": sequence },
						});
					}
					return { stopReason: "end_turn" };
				},
			});
			const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-sequence-${sequences.join("-")}` }));
			await expect(driver.read(handle)).rejects.toMatchObject({ code: "external_event_invalid" });
			await driver.dispose();
		}
	});

	it("validates stable tool-call lifecycle ordering and rejects draft tool names", async () => {
		for (const mode of ["valid", "update-before-create", "after-terminal", "draft-name"] as const) {
			const cwd = await workspace();
			const fixture = fakeAgent({
				onPrompt: async ({ client }) => {
					if (mode === "update-before-create") {
						await client.notify(CLIENT_METHODS.session_update, {
							sessionId,
							update: { sessionUpdate: "tool_call_update", toolCallId: "ordered-tool", status: "in_progress" },
						});
						return { stopReason: "end_turn" };
					}
					await client.notify(CLIENT_METHODS.session_update, {
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "ordered-tool",
							title: "Ordered tool",
							status: "pending",
							...(mode === "draft-name" ? { name: "draft.tool" } : {}),
						},
					});
					if (mode === "draft-name") return { stopReason: "end_turn" };
					for (const status of ["in_progress", "completed"] as const) {
						await client.notify(CLIENT_METHODS.session_update, {
							sessionId,
							update: { sessionUpdate: "tool_call_update", toolCallId: "ordered-tool", status },
						});
					}
					if (mode === "after-terminal") {
						await client.notify(CLIENT_METHODS.session_update, {
							sessionId,
							update: { sessionUpdate: "tool_call_update", toolCallId: "ordered-tool", status: "completed" },
						});
					}
					return { stopReason: "end_turn" };
				},
			});
			const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-tool-order-${mode}` }));
			if (mode === "valid") await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
			else await expect(driver.read(handle)).rejects.toMatchObject({
				code: mode === "draft-name" ? "external_protocol_unsupported" : "external_event_invalid",
			});
			await driver.dispose();
		}
	});

	it("returns method-not-found for unknown client operations and rejects unknown permission variants", async () => {
		const cwd = await workspace();
		const errors: number[] = [];
		const fixture = fakeAgent({
			onPrompt: async ({ client }) => {
				for (const [method, params] of [
					["vendor/unknown", {}],
					[
						CLIENT_METHODS.session_request_permission,
						{
							sessionId,
							toolCall: { toolCallId: "unknown-permission", title: "unknown" },
							options: [{ optionId: "future", name: "Future", kind: "future_allow" }],
						},
					],
				] as const) {
					try {
						await client.request<unknown, unknown>(method, params);
					} catch (error) {
						if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "number") {
							errors.push(error.code);
						}
					}
				}
				return { stopReason: "end_turn" };
			},
		});
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
		const handle = await driver.spawn(spawnRequest());
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		expect(errors).toEqual([-32601, -32602]);
		const iterator = driver.events(handle)[Symbol.asyncIterator]();
		expect((await nextDriverEvent(iterator)).type).toBe("started");
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
		await driver.dispose();
	});

	it("rejects unknown or draft initialize revisions before session creation", async () => {
		for (const initializeResponse of [
			{ protocolVersion: 2, agentCapabilities: { loadSession: true } },
			{ protocolVersion: 1, agentCapabilities: { loadSession: true, providers: {} } },
			{ protocolVersion: 1, agentCapabilities: { loadSession: true, draftCapability: {} } },
		] as const) {
			const cwd = await workspace();
			const fixture = fakeAgent({ initializeResponse: initializeResponse as unknown as InitializeResponse });
			const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
			await expect(driver.spawn(spawnRequest())).rejects.toMatchObject({ code: "external_protocol_unsupported" });
			expect(fixture.state.newSessionRequests).toEqual([]);
			await driver.dispose();
		}
	});

	it("bounds malformed and oversize stable transport frames", async () => {
		for (const mode of ["malformed", "oversize"] as const) {
			const cwd = await workspace();
			const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, rawProtocolTransport(mode), {
				limits: { maxFrameBytes: 1_024 },
			}));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-${mode}` }));
			await expect(driver.read(handle)).rejects.toMatchObject({
				code: mode === "malformed" ? "external_event_invalid" : "external_frame_oversize",
			});
			await driver.dispose();
		}

		const cwd = await workspace();
		const fixture = fakeAgent();
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app), {
			limits: { maxPendingWriteBytes: 32 },
		}));
		await expect(driver.spawn(spawnRequest({ operationNonce: "nonce-pending-write" }))).rejects.toMatchObject({
			code: "external_resource_limit_exceeded",
		});
		await driver.dispose();
	});

	it("canonicalizes encoded absolute paths and symlinks before ToolIntent and preserves protected review", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "protected"));
		const target = path.join(cwd, "protected", "result.txt");
		const fixture = fakeAgent({
			onPrompt: async ({ client }) => {
				await client.request(CLIENT_METHODS.fs_write_text_file, {
					sessionId,
					path: encodeURI(target),
					content: "protected",
				});
				return { stopReason: "end_turn" };
			},
		});
		const driver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(fixture.app)));
		const handle = await driver.spawn(spawnRequest());
		const iterator = driver.events(handle)[Symbol.asyncIterator]();
		expect((await nextDriverEvent(iterator)).type).toBe("started");
		const event = await nextToolEvent(iterator);
		const canonicalTarget = path.join(await realpath(cwd), "protected", "result.txt");
		expect(event.request.originalArguments).toMatchObject({ path: canonicalTarget });
		const route: ToolGatewayRoute = {
			kind: "local",
			namespace: "acp",
			toolName: "acp.fs.write_text_file",
			providerId: "workspace-provider",
			revision: 1,
			operation: { resource: "filesystem.write", effects: ["write"] },
		};
		const policyOperation = await classifyExternalToolPolicyOperation({
			request: event.request,
			route,
			cwd,
			roots: { workspace: cwd },
		});
		if (policyOperation.canonicalPath === undefined || policyOperation.effects === undefined) {
			throw new Error("Expected canonical protected path effects");
		}
		const classification = classifyProtectedPathOperation({
			policy: {
				rules: [{
					id: "protected-review",
					pattern: "protected/**",
					effects: ["write"],
					requirement: "reviewer",
					reviewerIds: ["reviewer-1"],
				}],
			},
			bindingId: attempt.bindingId,
			resource: policyOperation.resource,
			source: policyOperation.source,
			effects: policyOperation.effects,
			paths: [policyOperation.canonicalPath],
		});
		expect(classification).toMatchObject({ protected: true, requirement: "reviewer" });
		await settleTool(driver, handle, event);
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		await driver.dispose();

		const outside = await workspace();
		await symlink(outside, path.join(cwd, "escape"), "junction");
		let rejected = false;
		const escapeFixture = fakeAgent({
			onPrompt: async ({ client }) => {
				try {
					await client.request(CLIENT_METHODS.fs_write_text_file, {
						sessionId,
						path: path.join(cwd, "escape", "outside.txt"),
						content: "outside",
					});
				} catch {
					rejected = true;
				}
				return { stopReason: "end_turn" };
			},
		});
		const escapeDriver = new PrivateAcpStableV1Driver(driverOptions(cwd, transportFactory(escapeFixture.app)));
		const escapeHandle = await escapeDriver.spawn(spawnRequest({ operationNonce: "nonce-escape" }));
		await expect(escapeDriver.read(escapeHandle)).resolves.toMatchObject({ status: "succeeded" });
		expect(rejected).toBe(true);
		const escapeIterator = escapeDriver.events(escapeHandle)[Symbol.asyncIterator]();
		expect((await nextDriverEvent(escapeIterator)).type).toBe("started");
		expect(await escapeIterator.next()).toEqual({ done: true, value: undefined });
		await escapeDriver.dispose();
	});

	it("is package-private, pinned to the official stable SDK, and passive until explicit run", async () => {
		const cwd = await workspace();
		let transportOpens = 0;
		const fixture = fakeAgent();
		const factory = transportFactory(fixture.app, () => {
			transportOpens += 1;
		});
		const session = new Session(new InMemorySessionStorage({ id: "acp-composition", createdAt: 1 }));
		const ledger = new ContextLedger(session, { ownerId: "acp-composition" });
		const supervision = createExternalConnectorTestSupervision();
		const connector = createPrivateAcpExternalAgentConnector({
			providerId,
			capability,
			store: new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: ledger.writer })),
			supervision: supervision.options,
			transportFactory: factory,
			cwd,
			roots: { workspace: cwd },
			now: () => now,
			operationNonce: () => "nonce-composition",
		});
		const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, "../package.json"), "utf8")) as unknown;
		if (!isRecord(manifest) || !isRecord(manifest.dependencies)) throw new Error("Invalid coding-agent manifest");

		expect(PROTOCOL_VERSION).toBe(1);
		expect(manifest.dependencies["@agentclientprotocol/sdk"]).toBe("1.4.0");
		expect(Object.keys(packageEntry).filter((key) => key.toLowerCase().includes("acp"))).toEqual([]);
		expect(isHostSupervisedExternalAgentConnector(connector)).toBe(true);
		expect(getHostSupervisedExternalAgentConnectorImplementation(connector)).toBeDefined();
		expect(transportOpens).toBe(0);
		await connector.dispose();
		expect(transportOpens).toBe(0);
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
