import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
} from "@aos-agent/ai/compat";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import {
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/session/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/session/runtime.ts";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import { CapabilityPublicIdentity } from "../src/core/policy/capability-public-identity.ts";
import { CapabilityRegistry } from "../src/core/policy/capability-registry.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController } from "../src/modes/rpc/rpc-host.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

// ---------------------------------------------------------------------------
// In-memory MCP mock server with paginated resources and prompts.
// ---------------------------------------------------------------------------

const GUIDE_URI = "file:///guide.md";
const GUIDE_TEXT = "Attached guide text";
const SECRET_URI = "file:///vault/secret-credential.txt";
const SECRET_TEXT = "remote-credential-value";
const TEMPLATE_URI = "https://user:pass@example.com/x/{id}?token=sk";

interface MockContentServer {
	transportFactory: (config: { id: string }) => Promise<unknown>;
	received: Array<{ method: string; params: unknown }>;
}

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(serverCleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
});

function createContentMcpServer(
	opts: { readContents?: unknown[]; neverResolveReadUri?: string; withBlobResource?: boolean } = {},
): MockContentServer {
	const received: Array<{ method: string; params: unknown }> = [];
	return {
		transportFactory: async () => {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: "mock-content-server", version: "1.0.0" },
				{ capabilities: { tools: {}, resources: {}, prompts: {} } },
			);
			server.setRequestHandler(ListToolsRequestSchema, async (request) => {
				received.push({ method: "tools/list", params: request.params });
				return { tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }] as Tool[] };
			});
			server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
				received.push({ method: "resources/list", params: request.params });
				const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
				if (cursor === undefined) {
					const resources = [
						{ uri: GUIDE_URI, name: "Guide", mimeType: "text/markdown", size: 10 },
						{ uri: SECRET_URI, name: "Secret", mimeType: "text/plain", size: 12 },
					];
					if (opts.withBlobResource) {
						resources.push({ uri: "file:///blob", name: "Blob", mimeType: "application/octet-stream", size: 5 });
					}
					return { resources, nextCursor: "page-2" };
				}
				return { resources: [{ uri: "file:///extra.md", name: "Extra", mimeType: "text/markdown" }] };
			});
			server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
				received.push({ method: "resources/read", params: request.params });
				const uri = (request.params as { uri?: string } | undefined)?.uri;
				if (opts.neverResolveReadUri !== undefined && uri === opts.neverResolveReadUri) {
					// Hold the request open: only the caller signal can settle it.
					return new Promise<never>(() => {});
				}
				if (uri === SECRET_URI) {
					return { contents: [{ uri, mimeType: "text/plain", text: SECRET_TEXT }] };
				}
				if (uri === "file:///blob") {
					return { contents: [{ uri, blob: "aGVsbG8=", mimeType: "application/octet-stream" }] };
				}
				return {
					contents:
						opts.readContents ??
						([{ uri, mimeType: "text/markdown", text: GUIDE_TEXT }] as unknown[]),
				};
			});
			server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
				received.push({ method: "resources/templates/list", params: request.params });
				const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
				if (cursor === undefined) {
					return {
						resourceTemplates: [
							{
								uriTemplate: TEMPLATE_URI,
								name: "doc-by-id",
								title: "Document by id",
								mimeType: "text/markdown",
							},
						],
						nextCursor: "page-2",
					};
				}
				return {
					resourceTemplates: [{ uriTemplate: "file:///extra/{name}", name: "extra" }],
				};
			});
			server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
				received.push({ method: "prompts/list", params: request.params });
				const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
				if (cursor === undefined) {
					return { prompts: [{ name: "summarize", description: "Summarize a topic" }], nextCursor: "page-2" };
				}
				return { prompts: [{ name: "review", description: "Review changes" }] };
			});
			server.setRequestHandler(GetPromptRequestSchema, async (request) => {
				received.push({ method: "prompts/get", params: request.params });
				return {
					messages: [
						{ role: "user", content: { type: "text", text: "Summarize {topic}" } },
						{ role: "assistant", content: { type: "text", text: "Return a short summary." } },
					],
				};
			});
			server.connect(serverTransport).catch(() => undefined);
			serverCleanups.push(async () => {
				await server.close().catch(() => undefined);
				await clientTransport.close().catch(() => undefined);
			});
			return clientTransport;
		},
		received,
	};
}

// ---------------------------------------------------------------------------
// Session + RPC host harness.
// ---------------------------------------------------------------------------

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `aos-rpc-mcp-content-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { dir, agentDir };
}

function capabilitySettingsWithMcp(
	serverRules: Array<{ selector: unknown; action: "allow" | "ask" | "deny" }>,
): {
	capabilities: { defaultProfile: string; profiles: Record<string, { rules: unknown[] }> };
	mcp: { servers: Record<string, unknown> };
} {
	return {
		capabilities: {
			defaultProfile: "default",
			profiles: {
				default: {
					rules: [
						{ selector: { kind: "mcp_server" }, action: "allow" },
						{ selector: { kind: "mcp_tool" }, action: "allow" },
						{ selector: { kind: "mcp_resource" }, action: "allow" },
						{ selector: { kind: "mcp_resource_template" }, action: "allow" },
						{ selector: { kind: "mcp_prompt" }, action: "allow" },
						...serverRules,
					],
				},
			},
		},
		mcp: {
			servers: { docs: { transport: "stdio", command: "node" } },
		},
	};
}

function executionPolicySettings(rules: Array<{ resource: string; action: "allow" | "ask" | "deny" }>) {
	return {
		defaultProfile: "default",
		profiles: {
			default: {
				id: "default",
				enforcement: "host",
				defaultAction: "allow",
				workspace: {
					read: ["workspace"],
					write: ["workspace"],
					deny: [],
				},
				process: {
					action: "allow",
					inheritEnvironment: false,
					allowEnvironment: [],
					cwdScopes: ["workspace"],
					timeoutMs: 60_000,
				},
				network: { action: "allow", allowDestinations: [] },
				credentials: { action: "deny", allowNames: [] },
				approvals: {
					writeOutsideWorkspace: "deny",
					network: "deny",
					process: "allow",
				},
				rules,
			},
		},
	};
}

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
		model: "mock",
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

interface RpcMcpHarness {
	controller: RpcHostController;
	streamCalls: { count: number };
	received: MockContentServer["received"];
	cleanup: () => Promise<void>;
}

async function createRpcMcpHarness(opts: {
	settingsManager: SettingsManager;
	mock: MockContentServer;
}): Promise<RpcMcpHarness> {
	const temp = tmpDir("harness");
	const { dir, agentDir } = temp;
	mkdirSync(agentDir, { recursive: true });
	const identity = await CapabilityPublicIdentity.load(agentDir);
	const sessionManager = SessionManager.inMemory(dir);
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, dir);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const streamCalls = { count: 0 };
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			streamCalls.count++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
			});
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: opts.settingsManager,
		cwd: dir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		mcpTransportFactory: opts.mock.transportFactory as never,
		capabilityRegistry: new CapabilityRegistry(identity),
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setPrepareSessionRebind: vi.fn(),
	} as unknown as AgentSessionRuntime;
	const controller = new RpcHostController(runtimeHost);
	await controller.start();
	await session.whenCapabilitiesReady();
	return {
		controller,
		streamCalls,
		received: opts.mock.received,
		cleanup: async () => {
			try {
				await controller.shutdown();
			} catch {
				// best effort
			}
			session.dispose();
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		},
	};
}

function expectRpcResponse(record: unknown, command: string): RpcResponse {
	expect(record).toMatchObject({ type: "response", command, success: true });
	return record as RpcResponse;
}

function responseData<T>(response: RpcResponse): T {
	return (response as unknown as { data: T }).data;
}

describe("RPC MCP content wire contract (mcp.resource.* / mcp.prompt.*)", () => {
	it("lists, reads, gets and attaches with pagination, receipts and idempotent attach", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			// --- mcp.resource.list (page 1 + page 2 via cursor) ---
			const listPage1 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.list", serverId: "docs" }),
				"mcp.resource.list",
			);
			const listData1 = responseData<{ resources: Array<{ name: string }>; nextCursor?: string }>(listPage1);
			expect(listData1.resources.map((resource) => resource.name)).toEqual(["Guide", "Secret"]);
			expect(listData1.nextCursor).toBe("page-2");
			expect(JSON.stringify(listPage1)).not.toContain(GUIDE_URI);

			const listPage2 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.list", serverId: "docs", cursor: "page-2" }),
				"mcp.resource.list",
			);
			const listData2 = responseData<{ resources: Array<{ name: string }>; nextCursor?: string }>(listPage2);
			expect(listData2.resources.map((resource) => resource.name)).toEqual(["Extra"]);
			expect(listData2.nextCursor).toBeUndefined();

			// --- mcp.resource.read: redacted receipt, no raw URI or remote text ---
			const read = expectRpcResponse(
				await dispatch({ type: "mcp.resource.read", serverId: "docs", uri: SECRET_URI }),
				"mcp.resource.read",
			);
			const readData = responseData<{ resourceId: string; blocks: Array<{ kind: string }> }>(read);
			expect(readData.resourceId).not.toContain(SECRET_URI);
			expect(readData.blocks).toEqual([{ kind: "text", bytes: SECRET_TEXT.length, digest: expect.any(String) }]);
			const readJson = JSON.stringify(read);
			expect(readJson).not.toContain(SECRET_URI);
			expect(readJson).not.toContain(SECRET_TEXT);

			// --- mcp.resource.attach: explicit attach, receipt, idempotent ---
			const attach1 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.attach", serverId: "docs", uri: SECRET_URI }),
				"mcp.resource.attach",
			);
			const attachData1 = responseData<{
				id: string;
				kind: string;
				attachableBlockCount: number;
				text?: string;
			}>(attach1);
			expect(attachData1.kind).toBe("resource");
			expect(attachData1.attachableBlockCount).toBe(1);
			expect(attachData1.text).toBeUndefined();
			expect(JSON.stringify(attach1)).not.toContain(SECRET_URI);
			expect(JSON.stringify(attach1)).not.toContain(SECRET_TEXT);

			const attach2 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.attach", serverId: "docs", uri: SECRET_URI }),
				"mcp.resource.attach",
			);
			expect(responseData<{ id: string }>(attach2).id).toBe(attachData1.id);

			// --- mcp.prompt.list (page 1 + page 2 via cursor) ---
			const prompts1 = expectRpcResponse(
				await dispatch({ type: "mcp.prompt.list", serverId: "docs" }),
				"mcp.prompt.list",
			);
			const promptsData1 = responseData<{ prompts: Array<{ name: string }>; nextCursor?: string }>(prompts1);
			expect(promptsData1.prompts.map((prompt) => prompt.name)).toEqual(["summarize"]);
			expect(promptsData1.nextCursor).toBe("page-2");
			const prompts2 = expectRpcResponse(
				await dispatch({ type: "mcp.prompt.list", serverId: "docs", cursor: "page-2" }),
				"mcp.prompt.list",
			);
			expect(responseData<{ prompts: Array<{ name: string }> }>(prompts2).prompts.map((prompt) => prompt.name)).toEqual(
				["review"],
			);

			// --- mcp.prompt.get: redacted receipt, no name/args/remote text ---
			const gotten = expectRpcResponse(
				await dispatch({
					type: "mcp.prompt.get",
					serverId: "docs",
					name: "summarize",
					args: { topic: "MCP" },
				}),
				"mcp.prompt.get",
			);
			const gottenData = responseData<{ promptId: string; messages: unknown[] }>(gotten);
			expect(gottenData.messages).toHaveLength(2);
			expect(gottenData.promptId).not.toContain("summarize");
			const gottenJson = JSON.stringify(gotten);
			expect(gottenJson).not.toContain("summarize");
			expect(gottenJson).not.toContain("MCP");
			expect(gottenJson).not.toContain("Summarize {topic}");
			expect(gottenJson).not.toContain("Return a short summary.");

			// --- mcp.prompt.attach: explicit attach, receipt, idempotent ---
			const promptAttach1 = expectRpcResponse(
				await dispatch({
					type: "mcp.prompt.attach",
					serverId: "docs",
					name: "summarize",
					args: { topic: "MCP" },
				}),
				"mcp.prompt.attach",
			);
			const promptAttachData = responseData<{
				id: string;
				kind: string;
				attachableBlockCount: number;
				text?: string;
			}>(promptAttach1);
			expect(promptAttachData.kind).toBe("prompt");
			expect(promptAttachData.attachableBlockCount).toBe(2);
			expect(promptAttachData.text).toBeUndefined();
			expect(JSON.stringify(promptAttach1)).not.toContain("summarize");
			expect(JSON.stringify(promptAttach1)).not.toContain("MCP");
			const promptAttach2 = expectRpcResponse(
				await dispatch({
					type: "mcp.prompt.attach",
					serverId: "docs",
					name: "summarize",
					args: { topic: "MCP" },
				}),
				"mcp.prompt.attach",
			);
			expect(responseData<{ id: string }>(promptAttach2).id).toBe(promptAttachData.id);

			// Readiness listed metadata catalogs only; the rest are the explicit
			// operations. Nothing auto-read resources or prompts, and no model
			// stream was ever started.
			expect(mock.received.map((entry) => entry.method)).toEqual([
				"tools/list",
				"resources/list",
				"resources/templates/list",
				"prompts/list",
				"resources/list",
				"resources/list",
				"resources/read",
				"resources/read",
				"resources/read",
				"prompts/list",
				"prompts/list",
				"prompts/get",
				"prompts/get",
				"prompts/get",
			]);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed with redacted errors for unknown servers, unsupported content, and policy deny", async () => {
		const mock = createContentMcpServer({ withBlobResource: true });
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			// Unknown server: fixed template error code, never the raw URI.
			const unknown = await dispatch({ type: "mcp.resource.read", serverId: "missing", uri: SECRET_URI });
			expect(unknown).toMatchObject({ type: "response", command: "mcp.resource.read", success: false });
			const unknownError = unknown as unknown as { error: { code: string; message: string } };
			expect(unknownError.error.code).toBe("mcp_invalid_config");
			expect(unknownError.error.message).toContain("missing");
			expect(JSON.stringify(unknown)).not.toContain(SECRET_URI);

			// Unsupported content: fixed PR wire code (mcp_content_invalid), never the remote blob.
			const unsupported = await dispatch({ type: "mcp.resource.attach", serverId: "docs", uri: "file:///blob" });
			expect(unsupported).toMatchObject({ type: "response", command: "mcp.resource.attach", success: false });
			const unsupportedError = unsupported as unknown as { error: { code: string } };
			expect(unsupportedError.error.code).toBe("mcp_content_invalid");
			expect(JSON.stringify(unsupported)).not.toContain("blob");
			expect(JSON.stringify(unsupported)).not.toContain("AAAA");
		} finally {
			await harness.cleanup();
		}
	});

	it("denies reads under an execution policy deny rule without contacting the server", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory({
			...capabilitySettingsWithMcp([]),
			executionPolicy: executionPolicySettings([{ resource: "resource.read", action: "deny" }]),
		});
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const denied = await harness.controller.dispatch({
				type: "mcp.resource.read",
				serverId: "docs",
				uri: GUIDE_URI,
			});
			expect(denied).toMatchObject({ type: "response", command: "mcp.resource.read", success: false });
			const deniedError = denied as unknown as { error: { code: string; message: string } };
			expect(deniedError.error.code).toBe("mcp_policy_denied");
			expect(deniedError.error.message.length).toBeGreaterThan(0);
			expect(JSON.stringify(denied)).not.toContain(GUIDE_URI);
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps read-only commands available without initialize and gates attach after initialize", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			// Read-only list works without the Automation Host.
			const list = expectRpcResponse(
				await dispatch({ type: "mcp.resource.list", serverId: "docs" }),
				"mcp.resource.list",
			);
			expect(JSON.stringify(list)).not.toContain(GUIDE_URI);

			// initialize re-advertises the existing contract unchanged.
			const initialize = (await dispatch({ type: "initialize", protocolVersion: 1 })) as unknown as {
				data: { runCommands: string[] };
			};
			expect(initialize.data.runCommands).toEqual(["run.start", "run.get", "run.cancel", "run.resume"]);

			// Attach mutates session state, so it is rejected once the host is initialized.
			const attach = await dispatch({ type: "mcp.resource.attach", serverId: "docs", uri: GUIDE_URI });
			expect(attach).toMatchObject({ type: "response", command: "mcp.resource.attach", success: false });
			expect((attach as { error: string }).error).toContain("not available while the Automation Host is initialized");

			// Read-only commands remain available after initialize.
			const read = expectRpcResponse(
				await dispatch({ type: "mcp.resource.read", serverId: "docs", uri: GUIDE_URI }),
				"mcp.resource.read",
			);
			expect(JSON.stringify(read)).not.toContain(GUIDE_URI);
			expect(JSON.stringify(read)).not.toContain(GUIDE_TEXT);
		} finally {
			await harness.cleanup();
		}
	});

	it("lists resource templates with digest ids and a sanitized pattern, never the raw template", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			const page1 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.templates.list", serverId: "docs" }),
				"mcp.resource.templates.list",
			);
			const data1 = responseData<{
				resourceTemplates: Array<{
					templateId: string;
					name: string;
					displayPattern?: string;
					uriTemplateDigest: string;
				}>;
				nextCursor?: string;
			}>(page1);
			expect(data1.resourceTemplates).toHaveLength(1);
			expect(data1.resourceTemplates[0]).toMatchObject({
				serverId: "docs",
				name: "doc-by-id",
				displayPattern: "https://example.com/x/{id}",
			});
			expect(data1.resourceTemplates[0].templateId).not.toContain(TEMPLATE_URI);
			expect(data1.resourceTemplates[0].templateId).not.toContain("doc-by-id");
			expect(data1.nextCursor).toBe("page-2");
			const page1Json = JSON.stringify(page1);
			expect(page1Json).not.toContain(TEMPLATE_URI);
			expect(page1Json).not.toContain("user:pass");
			expect(page1Json).not.toContain("token=sk");

			const page2 = expectRpcResponse(
				await dispatch({ type: "mcp.resource.templates.list", serverId: "docs", cursor: "page-2" }),
				"mcp.resource.templates.list",
			);
			const data2 = responseData<{
				resourceTemplates: Array<{ name: string; displayPattern?: string }>;
				nextCursor?: string;
			}>(page2);
			expect(data2.resourceTemplates.map((template) => template.name)).toEqual(["extra"]);
			expect(data2.resourceTemplates[0].displayPattern).toBe("file:///extra/{name}");
			expect(data2.nextCursor).toBeUndefined();

			// Unknown server fails with the fixed content code, never the template.
			const unknown = await dispatch({
				type: "mcp.resource.templates.list",
				serverId: "missing",
			});
			expect(unknown).toMatchObject({ type: "response", command: "mcp.resource.templates.list", success: false });
			const unknownError = unknown as unknown as { error: { code: string } };
			expect(unknownError.error.code).toBe("mcp_invalid_config");
			expect(JSON.stringify(unknown)).not.toContain(TEMPLATE_URI);

			expect(mock.received.map((entry) => entry.method)).toEqual([
				"tools/list",
				"resources/list",
				"resources/templates/list",
				"prompts/list",
				"resources/templates/list",
				"resources/templates/list",
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("aborts an in-flight read through the host lifecycle signal on transport detach", async () => {
		const mock = createContentMcpServer({ neverResolveReadUri: GUIDE_URI });
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({
			settingsManager,
			mock,
		});
		try {
			const { controller } = harness;
			// The server holds the read open; only the host signal can settle it.
			const pending = controller.dispatch({
				type: "mcp.resource.read",
				serverId: "docs",
				uri: GUIDE_URI,
			}) as Promise<unknown>;

			// Wait until the request reached the server/session MCP operation.
			const deadline = Date.now() + 5000;
			while (!mock.received.some((entry) => entry.method === "resources/read") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(true);

			// Detaching the transport aborts the host signal (bounded: the detach
			// never awaits the in-flight command).
			await controller.detachTransport();
			const response = (await pending) as { success: boolean; error?: { code: string } };
			expect(response.success).toBe(false);
			expect(response.error?.code).toBe("mcp_aborted");
			expect(JSON.stringify(response)).not.toContain(GUIDE_URI);
			expect(JSON.stringify(response)).not.toContain(GUIDE_TEXT);

			// A fresh command after detach works against a new host signal.
			const after = expectRpcResponse(
				(await controller.dispatch({
					type: "mcp.resource.list",
					serverId: "docs",
				})) as RpcResponse,
				"mcp.resource.list",
			);
			expect(JSON.stringify(after)).not.toContain(GUIDE_URI);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects reads and gets of entries outside the catalog with operation-specific denied codes", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({ settingsManager, mock });
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			// A caller-supplied URI/name is never an approval: entries outside
			// the catalog surface the PR operation-specific denied codes.
			const deniedResource = (await dispatch({
				type: "mcp.resource.read",
				serverId: "docs",
				uri: "file:///not-listed.md",
			})) as unknown as { success: boolean; error: { code: string } };
			expect(deniedResource.success).toBe(false);
			expect(deniedResource.error.code).toBe("mcp_resource_denied");

			const deniedPrompt = (await dispatch({
				type: "mcp.prompt.get",
				serverId: "docs",
				name: "not-listed",
			})) as unknown as { success: boolean; error: { code: string } };
			expect(deniedPrompt.success).toBe(false);
			expect(deniedPrompt.error.code).toBe("mcp_prompt_denied");

			// Nothing reached the server.
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
			expect(mock.received.some((entry) => entry.method === "prompts/get")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("allows reads of an explicitly listed second page entry after the binding re-resolves", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const harness = await createRpcMcpHarness({ settingsManager, mock });
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			// file:///extra.md is only on page 2: reading it before the explicit
			// page-2 list is denied.
			const before = (await dispatch({
				type: "mcp.resource.read",
				serverId: "docs",
				uri: "file:///extra.md",
			})) as unknown as { success: boolean; error: { code: string } };
			expect(before.success).toBe(false);
			expect(before.error.code).toBe("mcp_resource_denied");

			// The explicit list joins the candidates and re-resolves the binding
			// while idle, so the listed entry becomes readable.
			const page = expectRpcResponse(
				(await dispatch({ type: "mcp.resource.list", serverId: "docs", cursor: "page-2" })) as RpcResponse,
				"mcp.resource.list",
			);
			const pageData = responseData<{ resources: Array<{ resourceId: string; name: string }> }>(page);
			expect(pageData.resources.map((resource) => resource.name)).toEqual(["Extra"]);

			const after = expectRpcResponse(
				(await dispatch({ type: "mcp.resource.read", serverId: "docs", uri: "file:///extra.md" })) as RpcResponse,
				"mcp.resource.read",
			);
			const afterData = responseData<{ resourceId: string }>(after);
			expect(afterData.resourceId).toBe(pageData.resources[0]?.resourceId);
			expect(JSON.stringify(after)).not.toContain("file:///extra.md");
		} finally {
			await harness.cleanup();
		}
	});

	it("surfaces mcp_resource_denied / mcp_prompt_denied for child deny rules on the wire", async () => {
		const mock = createContentMcpServer();
		const settingsManager = SettingsManager.inMemory(
			capabilitySettingsWithMcp([
				{ selector: { kind: "mcp_resource" }, action: "deny" },
				{ selector: { kind: "mcp_prompt" }, action: "deny" },
			]),
		);
		const harness = await createRpcMcpHarness({ settingsManager, mock });
		try {
			const { controller } = harness;
			const dispatch = (command: RpcCommand): Promise<RpcResponse | undefined> =>
				controller.dispatch(command) as Promise<RpcResponse | undefined>;

			const deniedResource = (await dispatch({
				type: "mcp.resource.read",
				serverId: "docs",
				uri: GUIDE_URI,
			})) as unknown as { success: boolean; error: { code: string } };
			expect(deniedResource.success).toBe(false);
			expect(deniedResource.error.code).toBe("mcp_resource_denied");

			const deniedPrompt = (await dispatch({
				type: "mcp.prompt.get",
				serverId: "docs",
				name: "summarize",
			})) as unknown as { success: boolean; error: { code: string } };
			expect(deniedPrompt.success).toBe(false);
			expect(deniedPrompt.error.code).toBe("mcp_prompt_denied");
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
			expect(mock.received.some((entry) => entry.method === "prompts/get")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
