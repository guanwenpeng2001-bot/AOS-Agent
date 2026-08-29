import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
	getModel,
} from "@aos-agent/ai/compat";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import { CapabilityRegistry } from "../src/core/capability-registry.ts";
import { MCPContentError } from "../src/core/mcp-content.ts";
import { PolicyError } from "../src/core/execution-policy.ts";
import { CONTEXT_SNAPSHOT_CUSTOM_TYPE } from "../src/core/session/context-engine.ts";
import { SessionManager, type SessionEntry } from "../src/core/session/manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `aos-mcp-content-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { dir, agentDir };
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

// ---------------------------------------------------------------------------
// In-memory MCP mock server with tools + resources + prompts.
// ---------------------------------------------------------------------------

interface MockServerOptions {
	readContents?: unknown[];
	promptMessages?: unknown[];
	holdRead?: boolean;
	holdPrompt?: boolean;
	/** When set, tools/list returns an empty tool list (content-only server). */
	noTools?: boolean;
	/** When set, resources/list returns two pages (second page: file:///second.md). */
	pagedResources?: boolean;
	/** When set, file:///blob is part of the resources catalog and returns blob content. */
	withBlobResource?: boolean;
}

interface MockServerSetup {
	transportFactory: (config: { id: string }) => Promise<unknown>;
	received: Array<{ method: string; params: unknown }>;
	releaseReadGate: () => void;
	releasePromptGate: () => void;
}

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(serverCleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
});

function createContentMcpServer(opts: MockServerOptions = {}): MockServerSetup {
	const received: Array<{ method: string; params: unknown }> = [];
	let releaseReadGate: (() => void) | undefined;
	const readGate = opts.holdRead
		? new Promise<void>((resolve) => {
				releaseReadGate = resolve;
			})
		: undefined;
	let releasePromptGate: (() => void) | undefined;
	const promptGate = opts.holdPrompt
		? new Promise<void>((resolve) => {
				releasePromptGate = resolve;
			})
		: undefined;
	return {
		transportFactory: async () => {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server(
				{ name: "mock-content-server", version: "1.0.0" },
				{ capabilities: { tools: {}, resources: {}, prompts: {} } },
			);
			server.setRequestHandler(ListToolsRequestSchema, async (request) => {
				received.push({ method: "tools/list", params: request.params });
				return {
					tools: opts.noTools
						? ([] as Tool[])
						: [{ name: "list", inputSchema: { type: "object", properties: {} } } as Tool],
				};
			});
			server.setRequestHandler(CallToolRequestSchema, async (request) => {
				received.push({ method: "tools/call", params: request.params });
				return { content: [{ type: "text", text: `ok:${request.params.name}` }] };
			});
			server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
				received.push({ method: "resources/list", params: request.params });
				const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
				if (opts.pagedResources && cursor !== undefined) {
					return {
						resources: [{ uri: "file:///second.md", name: "Second", mimeType: "text/markdown", size: 7 }],
					};
				}
				const resources = [{ uri: "file:///guide.md", name: "Guide", mimeType: "text/markdown", size: 10 }];
				if (opts.withBlobResource) {
					resources.push({ uri: "file:///blob", name: "Blob", mimeType: "application/octet-stream", size: 5 });
				}
				return {
					resources,
					...(opts.pagedResources ? { nextCursor: "p2" } : {}),
				};
			});
			server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
				received.push({ method: "resources/read", params: request.params });
				if (readGate !== undefined) {
					await readGate;
				}
				const uri = (request.params as { uri?: string } | undefined)?.uri;
				if (uri === "file:///blob") {
					return {
						contents: [{ uri, blob: "aGVsbG8=", mimeType: "application/octet-stream" }],
					};
				}
				return {
					contents:
						opts.readContents ??
						[{ uri: "file:///guide.md", mimeType: "text/markdown", text: "Attached guide text" }],
				};
			});
			server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
				received.push({ method: "resources/templates/list", params: request.params });
				return {
					resourceTemplates: [
						{ uriTemplate: "file:///docs/{id}", name: "doc-by-id", mimeType: "text/markdown" },
					],
				};
			});
			server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
				received.push({ method: "prompts/list", params: request.params });
				return { prompts: [{ name: "summarize", description: "Summarize a topic" }] };
			});
			server.setRequestHandler(GetPromptRequestSchema, async (request) => {
				received.push({ method: "prompts/get", params: request.params });
				if (promptGate !== undefined) {
					await promptGate;
				}
				return {
					messages:
						opts.promptMessages ?? [
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
		releaseReadGate: () => releaseReadGate?.(),
		releasePromptGate: () => releasePromptGate?.(),
	};
}

// ---------------------------------------------------------------------------
// Controllable assistant stream.
// ---------------------------------------------------------------------------

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

interface ContentSession {
	session: AgentSession;
	dir: string;
	agentDir: string;
	streamCalls: { count: number };
	captured: Array<{ systemPrompt: string | undefined; messages: unknown }>;
}

async function createContentSession(opts: {
	settingsManager: SettingsManager;
	mcpTransportFactory?: unknown;
	model?: Model<any>;
	streamCalls?: () => void;
}): Promise<ContentSession> {
	const temp = tmpDir("content");
	const dir = temp.dir;
	const agentDir = temp.agentDir;
	mkdirSync(agentDir, { recursive: true });
	const identity = await CapabilityPublicIdentity.load(agentDir);
	const sessionManager = SessionManager.inMemory(dir);
	const model = opts.model ?? getModel("anthropic", "claude-sonnet-4-5")!;
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, dir);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const captured: Array<{ systemPrompt: string | undefined; messages: unknown }> = [];
	const streamCalls = { count: 0 };
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: (_model, context) => {
			streamCalls.count++;
			opts.streamCalls?.();
			captured.push({ systemPrompt: context.systemPrompt, messages: context.messages });
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
		mcpTransportFactory: opts.mcpTransportFactory as never,
		capabilityRegistry: new CapabilityRegistry(identity),
	});
	return { session, dir, agentDir, streamCalls, captured };
}

function capabilitySettingsWithMcp(
	serverRules: Array<{ selector: unknown; action: "allow" | "ask" | "deny" }>,
	servers: Record<string, unknown> = { docs: { transport: "stdio", command: "node" } },
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
			servers,
		},
	};
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentSession MCP content list/read/get and attachments", () => {
	it("lists, reads and gets content on a trusted selected server without auto-reading", async () => {
		const { dir } = tmpDir("happy");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			// Readiness only ever listed metadata catalogs: no auto-read, no auto-get.
			expect(mock.received.map((entry) => entry.method)).toEqual([
				"tools/list",
				"resources/list",
				"resources/templates/list",
				"prompts/list",
			]);

			const listed = await session.listMcpResources("docs");
			expect(listed.serverId).toBe("docs");
			expect(listed.resources[0]).toMatchObject({ name: "Guide" });

			const read = await session.readMcpResource("docs", "file:///guide.md");
			expect(read.serverId).toBe("docs");
			expect(read.contents[0]).toMatchObject({ kind: "text", text: "Attached guide text" });
			expect(read.provenance.untrusted).toBe(true);
			// The raw URI never leaks into the result identity.
			expect(read.resourceId).not.toContain("file:///guide.md");
			expect(JSON.stringify(read)).not.toContain("file:///guide.md");

			const prompts = await session.listMcpPrompts("docs");
			expect(prompts.prompts[0]).toMatchObject({ name: "summarize" });

			const gotten = await session.getMcpPrompt("docs", "summarize", { topic: "MCP" });
			expect(gotten.promptId).not.toContain("summarize");
			expect(gotten.provenance.untrusted).toBe(true);
			expect(JSON.stringify(gotten)).not.toContain("summarize");
			// Argument values are never retained in the result.
			expect(JSON.stringify(gotten)).not.toContain("MCP");

			expect(mock.received.map((entry) => entry.method)).toEqual([
				"tools/list",
				"resources/list",
				"resources/templates/list",
				"prompts/list",
				"resources/list",
				"resources/read",
				"prompts/list",
				"prompts/get",
			]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("attaches resources and prompts explicitly and idempotently", async () => {
		const { dir } = tmpDir("attach");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const resource = await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			expect(resource.kind).toBe("resource");
			expect(resource.text).toBe("Attached guide text");
			expect(resource.provenance.untrusted).toBe(true);

			const prompt = await session.attachMcpPrompt({
				serverId: "docs",
				name: "summarize",
				args: { topic: "MCP" },
			});
			expect(prompt.kind).toBe("prompt");
			expect(prompt.text).toBe("Summarize {topic}\n\nReturn a short summary.");

			// Re-attaching the same content resolves to the same digest id.
			const again = await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			expect(again.id).toBe(resource.id);
			expect(session.listMcpAttachments().map((entry) => entry.id)).toEqual([resource.id, prompt.id]);
			expect(session.getMcpAttachment(resource.id)).toBe(resource);
			expect(session.getMcpAttachment("missing")).toBeUndefined();

			expect(session.detachMcpAttachment(resource.id)).toBe(true);
			expect(session.detachMcpAttachment(resource.id)).toBe(false);
			expect(session.listMcpAttachments().map((entry) => entry.id)).toEqual([prompt.id]);
			session.clearMcpAttachments();
			expect(session.listMcpAttachments()).toEqual([]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed for an unregistered server", async () => {
		const { dir } = tmpDir("unregistered");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([], {}));
		try {
			const { session } = await createContentSession({ settingsManager });
			await session.whenCapabilitiesReady();
			await expect(session.readMcpResource("missing", "file:///x")).rejects.toMatchObject({
				name: "MCPError",
				kind: "invalid_config",
			});
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed for a server the binding never approved", async () => {
		const { dir } = tmpDir("unapproved");
		// An ask capability that was never approved never enters the binding, so
		// the server is never selected and content operations fail closed.
		const settingsManager = SettingsManager.inMemory(
			capabilitySettingsWithMcp([{ selector: { kind: "mcp_server" }, action: "ask" }]),
		);
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();
			await expect(session.readMcpResource("docs", "file:///guide.md")).rejects.toMatchObject({
				name: "MCPError",
				kind: "not_selected",
			});
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed for an untrusted project server without ever connecting it", async () => {
		const { dir, agentDir } = tmpDir("untrusted");
		mkdirSync(join(dir, ".aos-agent"), { recursive: true });
		writeFileSync(
			join(dir, ".aos-agent", "settings.json"),
			JSON.stringify({ mcp: { servers: { docs: { transport: "stdio", command: "node" } } } }),
		);
		const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: false });
		let factoryCalls = 0;
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: (async () => {
					factoryCalls++;
					throw new Error("must never be called");
				}) as never,
			});
			await session.whenCapabilitiesReady();
			expect(factoryCalls).toBe(0);
			await expect(session.readMcpResource("docs", "file:///guide.md")).rejects.toMatchObject({
				name: "MCPError",
				kind: "not_selected",
			});
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies content operations under an execution policy deny rule", async () => {
		const { dir } = tmpDir("policy-deny");
		const settingsManager = SettingsManager.inMemory({
			...capabilitySettingsWithMcp([]),
			executionPolicy: executionPolicySettings([{ resource: "resource.read", action: "deny" }]),
		});
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();
			await expect(session.readMcpResource("docs", "file:///guide.md")).rejects.toBeInstanceOf(PolicyError);
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an attachment whose read result has no attachable blocks", async () => {
		const { dir } = tmpDir("unsupported");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		// file:///blob is part of the catalog (listed, selected) and returns a
		// blob body; the attach fails closed because nothing is attachable.
		const mock = createContentMcpServer({ withBlobResource: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();
			await expect(session.attachMcpResource({ serverId: "docs", uri: "file:///blob" })).rejects.toBeInstanceOf(
				MCPContentError,
			);
			expect(session.listMcpAttachments()).toEqual([]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never starts a model or changes system/developer instructions, and enters context as a message", async () => {
		const { dir } = tmpDir("no-model");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session, captured, streamCalls } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const attachment = await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			await session.attachMcpPrompt({ serverId: "docs", name: "summarize" });

			// Attaching never starts a model run.
			expect(streamCalls.count).toBe(0);
			expect(session.isIdle).toBe(true);

			await session.prompt("hello");
			const last = captured.at(-1);
			expect(last).toBeDefined();
			const serializedSystem = JSON.stringify(last?.systemPrompt ?? "");
			const serializedMessages = JSON.stringify(last?.messages ?? "");
			// Attached content enters the plan as a user message, never as a
			// system or developer instruction.
			expect(serializedMessages).toContain(attachment.text);
			expect(serializedSystem).not.toContain(attachment.text);
			expect(serializedSystem).not.toContain("Summarize {topic}");
			expect(serializedMessages).toContain("Summarize {topic}");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("abort (run cancel/close) cancels an in-flight read and settles waiters", async () => {
		const { dir } = tmpDir("cancel");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer({ holdRead: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const read = session.readMcpResource("docs", "file:///guide.md");
			await waitUntil(() => mock.received.some((entry) => entry.method === "resources/read"));
			await session.abort();
			mock.releaseReadGate();
			await expect(read).rejects.toMatchObject({ name: "AbortError" });
			expect(session.isIdle).toBe(true);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dispose cancels an in-flight prompt get", async () => {
		const { dir } = tmpDir("dispose");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer({ holdPrompt: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const get = session.getMcpPrompt("docs", "summarize", { topic: "MCP" });
			await waitUntil(() => mock.received.some((entry) => entry.method === "prompts/get"));
			session.dispose();
			mock.releasePromptGate();
			await expect(get).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails the run start with context_budget_exceeded when an attachment cannot fit", async () => {
		const { dir } = tmpDir("budget");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 2_048 };
		const mock = createContentMcpServer({
			readContents: [{ uri: "file:///guide.md", mimeType: "text/plain", text: "word ".repeat(30_000) }],
		});
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
				model,
			});
			await session.whenCapabilitiesReady();
			await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });

			await expect(session.prompt("hello")).rejects.toMatchObject({
				name: "ContextRuntimeError",
				contextError: { code: "context_budget_exceeded" },
			});
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers discovered content capabilities with parent linkage and secret-free identities", async () => {
		const { dir } = tmpDir("catalog");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const catalog = session.inspectCapabilityCatalog();
			const serverDescriptor = catalog.descriptors.find(
				(candidate) => candidate.kind === "mcp_server" && candidate.mcpServerId === "docs",
			);
			expect(serverDescriptor).toBeDefined();
			for (const kind of ["mcp_resource", "mcp_resource_template", "mcp_prompt"] as const) {
				const children = catalog.descriptors.filter(
					(candidate) => candidate.kind === kind && candidate.mcpServerId === "docs",
				);
				expect(children.length).toBeGreaterThan(0);
				for (const child of children) {
					// The child is parented to the mcp_server descriptor, never an
					// orphan; the stable id is a digest, never the raw URI or name.
					expect(child.parentId).toBe(serverDescriptor?.id);
					expect(child.trusted).toBe(true);
					expect(child.id).not.toContain("file://");
					expect(child.id).not.toContain("summarize");
				}
			}
			expect(JSON.stringify(catalog)).not.toContain("file:///guide.md");
			expect(JSON.stringify(catalog)).not.toContain("file:///docs/{id}");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blocks content operations when a child deny restricts the server allow", async () => {
		const { dir } = tmpDir("child-deny");
		const settingsManager = SettingsManager.inMemory(
			capabilitySettingsWithMcp([
				{ selector: { kind: "mcp_resource" }, action: "deny" },
				{ selector: { kind: "mcp_prompt" }, action: "deny" },
			]),
		);
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			await expect(session.listMcpResources("docs")).rejects.toMatchObject({ code: "capability_denied" });
			await expect(session.readMcpResource("docs", "file:///guide.md")).rejects.toMatchObject({
				code: "capability_denied",
			});
			await expect(session.listMcpPrompts("docs")).rejects.toMatchObject({ code: "capability_denied" });
			await expect(session.getMcpPrompt("docs", "summarize")).rejects.toMatchObject({
				code: "capability_denied",
			});
			// The deny is enforced before any remote read/get.
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
			expect(mock.received.some((entry) => entry.method === "prompts/get")).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blocks content operations for an unapproved ask child until the session approves it", async () => {
		const { dir } = tmpDir("ask");
		const settingsManager = SettingsManager.inMemory(
			capabilitySettingsWithMcp([{ selector: { kind: "mcp_resource" }, action: "ask" }]),
		);
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const catalog = session.inspectCapabilityCatalog();
			const resourceChild = catalog.descriptors.find(
				(candidate) => candidate.kind === "mcp_resource" && candidate.mcpServerId === "docs",
			);
			expect(resourceChild).toBeDefined();
			await expect(session.readMcpResource("docs", "file:///guide.md")).rejects.toMatchObject({
				code: "capability_denied",
			});

			// The ask approval is session-local and flips the child into the binding.
			await session.approveCapability(resourceChild!.id);
			const read = await session.readMcpResource("docs", "file:///guide.md");
			expect(read.contents[0]).toMatchObject({ kind: "text", text: "Attached guide text" });
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects reads and gets of entries outside the catalog", async () => {
		const { dir } = tmpDir("out-of-catalog");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			// A caller-supplied raw URI is never an approval: only catalogued and
			// binding-selected digest descriptors pass the gate.
			await expect(session.readMcpResource("docs", "file:///not-listed.md")).rejects.toMatchObject({
				code: "capability_denied",
			});
			await expect(session.getMcpPrompt("docs", "not-listed")).rejects.toMatchObject({
				code: "capability_denied",
			});
			expect(mock.received.some((entry) => entry.method === "resources/read")).toBe(false);
			expect(mock.received.some((entry) => entry.method === "prompts/get")).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows reads of entries from explicit later pages after the binding re-resolves", async () => {
		const { dir } = tmpDir("second-page");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer({ pagedResources: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			// The second page entry is not part of the readiness page-1 snapshot:
			// reading it before the explicit list is denied.
			await expect(session.readMcpResource("docs", "file:///second.md")).rejects.toMatchObject({
				code: "capability_denied",
			});

			// The explicit list page joins the candidates and the binding
			// re-resolves while idle, so the listed entry becomes readable.
			const page = await session.listMcpResources("docs", { cursor: "p2" });
			expect(page.resources[0]).toMatchObject({ name: "Second" });
			const read = await session.readMcpResource("docs", "file:///second.md");
			expect(read.resourceId).toBe(page.resources[0]?.resourceId);
			expect(read.contents[0]).toMatchObject({ kind: "text", text: "Attached guide text" });
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers content capabilities of a content-only server (no tools) into the binding", async () => {
		const { dir } = tmpDir("content-only");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer({ noTools: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const catalog = session.inspectCapabilityCatalog();
			expect(
				catalog.descriptors.filter((candidate) => candidate.kind === "mcp_resource").length,
			).toBeGreaterThan(0);
			const read = await session.readMcpResource("docs", "file:///guide.md");
			expect(read.contents[0]).toMatchObject({ kind: "text", text: "Attached guide text" });
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps explicitly listed page-2 entries across a fresh discovery (successor binding)", async () => {
		const { dir } = tmpDir("successor");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer({ pagedResources: true });
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			// The second page entry joins the candidates and the binding.
			await session.listMcpResources("docs", { cursor: "p2" });
			expect(await session.readMcpResource("docs", "file:///second.md")).toBeDefined();

			// A fresh discovery (profile re-materialization re-runs readiness)
			// merges its page-1 snapshot with the preserved explicit page-2
			// candidates instead of dropping them; the successor binding keeps
			// the entry readable.
			await session.setCapabilityProfile("default");
			expect(await session.readMcpResource("docs", "file:///second.md")).toBeDefined();
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records the capability and policy binding ids on attachments", async () => {
		const { dir } = tmpDir("binding-ids");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const attachment = await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			expect(attachment.capabilityBindingId).toBe(session.getCapabilityBindingId());
			expect(attachment.policyBindingId).toBe(session.getActiveExecutionPolicyBinding()?.id);
			expect(attachment.capabilityBindingId.length).toBeGreaterThan(0);
			expect(attachment.policyBindingId?.length).toBeGreaterThan(0);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records allowlist-only mcp.content.audit entries for explicit attaches", async () => {
		const { dir } = tmpDir("audit-entries");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			await session.attachMcpPrompt({ serverId: "docs", name: "summarize", args: { topic: "MCP" } });

			const entries = session.sessionRead
				.getEntries()
				.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === "mcp.content.audit",
				);
			expect(entries).toHaveLength(2);
			for (const entry of entries) {
				const data = entry.data as Record<string, unknown>;
				expect(data.serverId).toBe("docs");
				expect(data.operation).toBe("context.attach");
				expect(data.outcome).toBe("success");
				// Safe metadata only: descriptor id/revision, source digest, content
				// digest, byte/block counts, MIME types, binding ids, timestamp.
				expect(typeof data.descriptorId).toBe("string");
				expect(typeof data.revision).toBe("string");
				expect(typeof data.provenanceId).toBe("string");
				expect(typeof data.contentDigest).toBe("string");
				expect(typeof data.byteCount).toBe("number");
				expect(typeof data.blockCount).toBe("number");
				expect(typeof data.capabilityBindingId).toBe("string");
				expect(typeof data.policyBindingId).toBe("string");
				expect(typeof data.timestamp).toBe("string");
			}
			// Never raw URI, prompt name, argument value, or remote text.
			const serialized = JSON.stringify(entries);
			expect(serialized).not.toContain("file:///guide.md");
			expect(serialized).not.toContain("summarize");
			expect(serialized).not.toContain("MCP");
			expect(serialized).not.toContain("Attached guide text");
			expect(serialized).not.toContain("Summarize this");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records a fixed reason code for a failed attach without raw error text", async () => {
		const { dir } = tmpDir("audit-failed");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			await expect(session.attachMcpResource({ serverId: "missing", uri: "file:///nope.md" })).rejects.toThrow();

			const entries = session.sessionRead
				.getEntries()
				.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === "mcp.content.audit",
				);
			expect(entries).toHaveLength(1);
			const data = entries[0].data as Record<string, unknown>;
			expect(data.serverId).toBe("missing");
			expect(data.operation).toBe("context.attach");
			expect(data.outcome).toBe("failed");
			expect(data.reasonCode).toBe("invalid_config");
			// The fixed code-derived reason never includes the raw error message.
			expect(JSON.stringify(entries)).not.toContain("No configuration registered");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records attachment digest/size/descriptor metadata on the context snapshot receipt", async () => {
		const { dir } = tmpDir("snapshot-receipt");
		const settingsManager = SettingsManager.inMemory(capabilitySettingsWithMcp([]));
		const mock = createContentMcpServer();
		try {
			const { session } = await createContentSession({
				settingsManager,
				mcpTransportFactory: mock.transportFactory,
			});
			await session.whenCapabilitiesReady();

			const attachment = await session.attachMcpResource({ serverId: "docs", uri: "file:///guide.md" });
			await session.prompt("hello");

			const snapshotEntry = session.sessionRead
				.getEntries()
				.find((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === CONTEXT_SNAPSHOT_CUSTOM_TYPE,
				);
			expect(snapshotEntry).toBeDefined();
			const snapshot = snapshotEntry?.data as {
				sources: Array<Record<string, unknown>>;
			};
			const receipt = snapshot.sources.find((source) => source.sourceId === attachment.id);
			expect(receipt).toMatchObject({
				kind: "attachment",
				trust: "user_owned",
				disposition: "included",
				byteCount: attachment.byteCount,
				blockCount: attachment.blockCount,
				capabilityId: attachment.descriptorId,
				capabilityRevision: attachment.descriptorRevision,
			});
			// The snapshot never carries the remote body or the raw URI.
			const serialized = JSON.stringify(snapshotEntry?.data);
			expect(serialized).not.toContain("Attached guide text");
			expect(serialized).not.toContain("file:///guide.md");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});
});
