import { afterEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import {
	GetPromptRequestSchema,
	type JSONRPCMessage,
	ListPromptsRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
	ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport";
import {
	createMCPHttpTransport,
	MCPLifecycleManager,
	MCPServerLifecycle,
} from "../src/core/mcp-lifecycle.ts";
import { MCPContentError, mcpPromptId, mcpResourceId } from "../src/core/mcp-content.ts";
import {
	DEFAULT_MCP_CONTENT_LIMITS,
	type MCPAuthProviderResolver,
	type MCPContentLimits,
	type MCPServerConfig,
	MCPError,
} from "../src/core/mcp-types.ts";

const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface ResourcePromptMockOptions {
	/** Server capabilities to advertise; defaults to resources + prompts with listChanged. */
	capabilities?: Record<string, unknown>;
	pages?: Array<{
		resources?: unknown[];
		resourceTemplates?: unknown[];
		prompts?: unknown[];
		nextCursor?: string;
	}>;
	readContents?: unknown[];
	promptMessages?: unknown[];
	/** When set, readResource blocks until releaseReadGate() is invoked. */
	holdRead?: boolean;
	/** When set, getPrompt blocks until releasePromptGate() is invoked. */
	holdPrompt?: boolean;
	/** When set, every list/read/get handler waits this long before replying. */
	handlerDelayMs?: number;
}

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(
		serverCleanups
			.splice(0)
			.map((cleanup) => cleanup().catch(() => undefined)),
	);
});

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function createResourcePromptServer(opts: ResourcePromptMockOptions = {}): {
	server: Server;
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	received: Array<{ method: string; params: unknown }>;
	releaseReadGate: () => void;
	releasePromptGate: () => void;
} {
	const capabilities = opts.capabilities ?? {
		tools: {},
		resources: { listChanged: true },
		prompts: { listChanged: true },
	};
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = new Server(
		{ name: "mock-resource-server", version: "1.0.0" },
		{ capabilities },
	);
	const received: Array<{ method: string; params: unknown }> = [];
	const pages = opts.pages ?? [{ resources: [], resourceTemplates: [], prompts: [] }];

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
	const delay = (): Promise<void> =>
		opts.handlerDelayMs === undefined ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, opts.handlerDelayMs!));

	const record = (method: string, params: unknown): void => {
		received.push({ method, params });
	};

	const pageIndex = (params: unknown): number => {
		const cursor = (params as { cursor?: string } | undefined)?.cursor;
		return cursor === undefined ? 0 : Number(cursor);
	};

	// The SDK Server asserts that a request handler matches an advertised
	// capability at registration time, so handlers are installed only for
	// advertised capabilities (mirroring what a real server would do).
	if (capabilities.resources !== undefined) {
		server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
			record("resources/list", request.params);
			await delay();
			const page = pages[pageIndex(request.params)];
			return {
				resources: page?.resources ?? [],
				...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
			};
		});

		server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
			record("resources/templates/list", request.params);
			await delay();
			const page = pages[pageIndex(request.params)];
			return {
				resourceTemplates: page?.resourceTemplates ?? [],
				...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
			};
		});

		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			record("resources/read", request.params);
			await delay();
			if (readGate !== undefined) {
				await readGate;
			}
			return { contents: opts.readContents ?? [] };
		});
	}
	if (capabilities.prompts !== undefined) {
		server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
			record("prompts/list", request.params);
			await delay();
			const page = pages[pageIndex(request.params)];
			return {
				prompts: page?.prompts ?? [],
				...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
			};
		});

		server.setRequestHandler(GetPromptRequestSchema, async (request) => {
			record("prompts/get", request.params);
			await delay();
			if (promptGate !== undefined) {
				await promptGate;
			}
			return { messages: opts.promptMessages ?? [] };
		});
	}

	const serverReady = server.connect(serverTransport);
	serverReady.catch(() => undefined);

	serverCleanups.push(async () => {
		await server.close().catch(() => undefined);
		await clientTransport.close().catch(() => undefined);
	});

	return {
		server,
		transportFactory: async () => clientTransport,
		received,
		releaseReadGate: () => releaseReadGate?.(),
		releasePromptGate: () => releasePromptGate?.(),
	};
}

function lifecycleWith(
	opts: ResourcePromptMockOptions,
	lifecycleOpts: {
		requestTimeoutMs?: number;
		contentLimits?: MCPContentLimits;
		authProvider?: MCPAuthProviderResolver;
	} = {},
): {
	lifecycle: MCPServerLifecycle;
	setup: ReturnType<typeof createResourcePromptServer>;
} {
	const setup = createResourcePromptServer(opts);
	const lifecycle = new MCPServerLifecycle(
		{ id: "docs", transport: "stdio", command: "node" },
		{
			transportFactory: setup.transportFactory,
			...(lifecycleOpts.requestTimeoutMs !== undefined ? { requestTimeoutMs: lifecycleOpts.requestTimeoutMs } : {}),
			...(lifecycleOpts.contentLimits !== undefined ? { contentLimits: lifecycleOpts.contentLimits } : {}),
			...(lifecycleOpts.authProvider !== undefined ? { authProvider: lifecycleOpts.authProvider } : {}),
		},
	);
	serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));
	return { lifecycle, setup };
}

function managerWith(
	configs: ReadonlyArray<MCPServerConfig>,
	opts: {
		selected?: ReadonlyArray<string>;
		transportFactory?: (config: MCPServerConfig) => Promise<Transport>;
		contentLimits?: MCPContentLimits;
	} = {},
): MCPLifecycleManager {
	const manager = new MCPLifecycleManager({
		selectedServerIds: new Set(opts.selected ?? configs.map((config) => config.id)),
		...(opts.transportFactory !== undefined ? { transportFactory: opts.transportFactory } : {}),
		...(opts.contentLimits !== undefined ? { contentLimits: opts.contentLimits } : {}),
	});
	manager.registerServers(configs);
	serverCleanups.push(async () => {
		await manager.closeAll().catch(() => undefined);
	});
	return manager;
}

describe("MCP resources/prompts lifecycle with in-memory transport", () => {
	it("lists resources with cursor pagination and sanitized summaries", async () => {
		const { lifecycle, setup } = lifecycleWith({
			pages: [
				{
					resources: [
						{ uri: "file:///a.md", name: "A\u0000", mimeType: "text/markdown", size: 10 },
						{ uri: "file:///b.txt", name: "B", mimeType: "not-a-mime" },
					],
					nextCursor: "1",
				},
				{ resources: [{ uri: "file:///c.md", name: "C" }] },
			],
		});
		await lifecycle.connect();

		const first = await lifecycle.listResources();
		expect(first.resources).toHaveLength(2);
		expect(first.nextCursor).toBe("1");
		expect(first.resources[0]).toMatchObject({
			serverId: "docs",
			name: "A",
			mimeType: "text/markdown",
			size: 10,
		});
		expect(first.resources[0].resourceId).toBe(mcpResourceId("docs", "file:///a.md"));
		// invalid MIME is dropped from catalog metadata, never a failure
		expect(first.resources[1].mimeType).toBeUndefined();
		const serialized = JSON.stringify(first);
		expect(serialized).not.toContain("file:///a.md");
		expect(serialized).not.toContain("not-a-mime");

		const second = await lifecycle.listResources({ cursor: first.nextCursor });
		expect(second.resources.map((resource) => resource.name)).toEqual(["C"]);
		expect(second.nextCursor).toBeUndefined();
		expect(setup.received.map((entry) => entry.method)).toEqual(["resources/list", "resources/list"]);
		expect(setup.received[1].params).toEqual({ cursor: "1" });
	});

	it("lists resource templates with digest-based identities", async () => {
		const { lifecycle } = lifecycleWith({
			pages: [
				{
					resourceTemplates: [
						{ uriTemplate: "https://user:pass@h/x/{id}?token=sk", name: "t" },
					],
				},
			],
		});
		await lifecycle.connect();
		const result = await lifecycle.listResourceTemplates();
		expect(result.resourceTemplates).toHaveLength(1);
		expect(result.resourceTemplates[0]).toMatchObject({ serverId: "docs", name: "t" });
		expect(result.resourceTemplates[0].displayPattern).toBe("https://h/x/{id}");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("token=sk");
		expect(serialized).not.toContain("sk");
	});

	it("reads a resource into normalized untrusted content without retaining the URI", async () => {
		const { lifecycle, setup } = lifecycleWith({
			readContents: [
				{ uri: "file:///docs/readme.md", text: "hello\u0000world", mimeType: "text/markdown" },
				{ uri: "file:///docs/blob", blob: PNG_1PX, mimeType: "image/png" },
			],
		});
		await lifecycle.connect();
		const result = await lifecycle.readResource("file:///docs/readme.md");
		expect(result.resourceId).toBe(mcpResourceId("docs", "file:///docs/readme.md"));
		expect(result.contents[0]).toMatchObject({ kind: "text", text: "helloworld" });
		expect(result.contents[1]).toMatchObject({ kind: "unattached", reason: "blob", mimeType: "image/png" });
		expect(result.provenance).toMatchObject({
			serverId: "docs",
			source: "resource",
			sourceId: result.resourceId,
			untrusted: true,
			blockCount: 2,
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("file:///docs/readme.md");
		expect(serialized).not.toContain("file:///docs/blob");
		// the URI was sent once and only once
		expect(setup.received).toEqual([{ method: "resources/read", params: { uri: "file:///docs/readme.md" } }]);
		// no status/state change beyond ready
		expect(lifecycle.getStatus()).toMatchObject({ state: "ready", availability: "available" });
		expect(lifecycle.getStatus().lastError).toBeUndefined();
	});

	it("lists prompts and gets a prompt with roles preserved and args validated", async () => {
		const { lifecycle, setup } = lifecycleWith({
			pages: [{ prompts: [{ name: "greet", description: "say hi", arguments: [{ name: "who", required: true }] }] }],
			promptMessages: [
				{ role: "user", content: { type: "text", text: "hi" } },
				{ role: "assistant", content: { type: "text", text: "hello {who}" } },
			],
		});
		await lifecycle.connect();

		const listed = await lifecycle.listPrompts();
		expect(listed.prompts[0]).toMatchObject({
			promptId: mcpPromptId("docs", "greet"),
			name: "greet",
			arguments: [{ name: "who", required: true }],
		});

		const result = await lifecycle.getPrompt("greet", { who: "there\u0000" });
		expect(result.promptId).toBe(mcpPromptId("docs", "greet"));
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(result.messages[1].blocks[0]).toMatchObject({ kind: "text", text: "hello {who}" });
		expect(result.provenance.untrusted).toBe(true);
		// the argument value was sent sanitized and never retained
		expect(setup.received[1].params).toEqual({ name: "greet", arguments: { who: "there" } });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("there");
		expect(serialized).not.toContain("greet\u0000");
	});

	it("fails with fixed errors without calling the SDK when the capability is unsupported", async () => {
		const setup = createResourcePromptServer({ capabilities: { tools: {} } });
		const lifecycle = new MCPServerLifecycle(
			{ id: "docs", transport: "stdio", command: "node" },
			{ transportFactory: setup.transportFactory },
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));
		await lifecycle.connect();

		await expect(lifecycle.listResources()).rejects.toMatchObject({
			name: "MCPContentError",
			code: "mcp_resource_unavailable",
		});
		await expect(lifecycle.listResourceTemplates()).rejects.toMatchObject({
			code: "mcp_resource_unavailable",
		});
		await expect(lifecycle.readResource("file:///a")).rejects.toMatchObject({
			code: "mcp_resource_unavailable",
		});
		await expect(lifecycle.listPrompts()).rejects.toMatchObject({
			code: "mcp_prompt_unavailable",
		});
		await expect(lifecycle.getPrompt("p")).rejects.toMatchObject({
			code: "mcp_prompt_unavailable",
		});
		// the undeclared SDK methods were never invoked
		expect(setup.received).toEqual([]);
		// the server itself is healthy; unsupported is not a failure
		expect(lifecycle.getStatus()).toMatchObject({ state: "ready", availability: "available" });
	});

	it("rejects an oversized read with a fixed error and marks the server degraded", async () => {
		const { lifecycle } = lifecycleWith(
			{
				readContents: [{ uri: "file:///big", text: "x".repeat(DEFAULT_MCP_CONTENT_LIMITS.maxTextBytes + 1) }],
			},
			{ contentLimits: { ...DEFAULT_MCP_CONTENT_LIMITS, maxTextBytes: 64 } },
		);
		await lifecycle.connect();
		const error = await lifecycle.readResource("file:///big").catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(MCPContentError);
		expect((error as MCPContentError).code).toBe("mcp_content_oversize");
		expect(lifecycle.getStatus()).toMatchObject({ state: "degraded", availability: "degraded" });
	});

	it("cancels a pending read with AbortError without degrading the server", async () => {
		const { lifecycle, setup } = lifecycleWith({ holdRead: true, readContents: [{ uri: "file:///a", text: "x" }] });
		await lifecycle.connect();

		const controller = new AbortController();
		const readPromise = lifecycle.readResource("file:///a", controller.signal);
		await waitUntil(() => setup.received.length === 1);

		controller.abort();
		await expect(readPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(lifecycle.getStatus()).toMatchObject({ state: "ready", availability: "available" });
		setup.releaseReadGate();
	});

	it("close() cancels pending catalog operations and settles the connection", async () => {
		const { lifecycle, setup } = lifecycleWith({ holdRead: true });
		await lifecycle.connect();

		const readPromise = lifecycle.readResource("file:///a");
		await waitUntil(() => setup.received.length === 1);

		const closePromise = lifecycle.close();
		await expect(readPromise).rejects.toMatchObject({
			code: "capability_mcp_unavailable",
		});
		await closePromise;
		expect(lifecycle.getStatus()).toMatchObject({ state: "closed", availability: "unavailable" });
		setup.releaseReadGate();
	});

	it("forceClose() cancels a pending getPrompt", async () => {
		const { lifecycle, setup } = lifecycleWith({
			holdPrompt: true,
			promptMessages: [{ role: "user", content: { type: "text", text: "x" } }],
		});
		await lifecycle.connect();

		const getPromise = lifecycle.getPrompt("p", { q: "1" });
		await waitUntil(() => setup.received.length === 1);

		const forceClosePromise = lifecycle.forceClose();
		await expect(getPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await forceClosePromise;
		expect(lifecycle.getStatus()).toMatchObject({ state: "closed" });
		setup.releasePromptGate();
	});

	it("maps a request timeout to degraded without leaking remote error text", async () => {
		const { lifecycle } = lifecycleWith(
			{ readContents: [{ uri: "file:///a", text: "x" }], handlerDelayMs: 200 },
			{ requestTimeoutMs: 30 },
		);
		await lifecycle.connect();
		const error = await lifecycle.readResource("file:///a").catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(MCPError);
		expect((error as MCPError).kind).toBe("unavailable");
		expect((error as MCPError).code).toBe("capability_mcp_unavailable");
		expect(JSON.stringify(error)).not.toContain("RequestTimeout");
		expect(JSON.stringify(error)).not.toContain("-32001");
		expect(lifecycle.getStatus()).toMatchObject({ state: "degraded" });
	});

	it("marks the catalog stale on list-changed notifications and clears it on the next list", async () => {
		const { lifecycle, setup } = lifecycleWith({
			pages: [{ resources: [{ uri: "file:///a", name: "A" }] }],
		});
		await lifecycle.connect();
		expect(lifecycle.getStatus().catalogStale).toBeUndefined();

		await setup.server.notification(
			ResourceListChangedNotificationSchema.parse({ method: "notifications/resources/list_changed" }),
		);
		await waitUntil(() => lifecycle.getStatus().catalogStale === true);
		expect(lifecycle.getStatus().catalogStale).toBe(true);

		// a successful list reflects the server's current catalog and clears the flag
		await lifecycle.listResources();
		expect(lifecycle.getStatus().catalogStale).toBeUndefined();
		expect(setup.received[0]).toMatchObject({ method: "resources/list" });
	});

	it("fails with capability unavailable when the server drops mid-operation", async () => {
		const { lifecycle, setup } = lifecycleWith({
			holdRead: true,
			readContents: [{ uri: "file:///a", text: "x" }],
		});
		await lifecycle.connect();

		const readPromise = lifecycle.readResource("file:///a");
		await waitUntil(() => setup.received.length === 1);
		await setup.server.close();
		await waitUntil(() => lifecycle.getStatus().state === "degraded");

		await expect(readPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		setup.releaseReadGate();
	});

	it("gates every resource/prompt method behind the selected-server binding", async () => {
		const setup = createResourcePromptServer();
		const manager = managerWith(
			[
				{ id: "selected", transport: "stdio", command: "node" },
				{ id: "unselected", transport: "stdio", command: "node" },
			],
			{ selected: ["selected"], transportFactory: setup.transportFactory },
		);
		const gate = { kind: "not_selected", serverId: "unselected", code: "capability_denied" };
		await expect(manager.listResources("unselected")).rejects.toMatchObject(gate);
		await expect(manager.listResourceTemplates("unselected")).rejects.toMatchObject(gate);
		await expect(manager.readResource("unselected", "file:///a")).rejects.toMatchObject(gate);
		await expect(manager.listPrompts("unselected")).rejects.toMatchObject(gate);
		await expect(manager.getPrompt("unselected", "p")).rejects.toMatchObject(gate);
		expect(manager.getStatus("unselected")).toMatchObject({ state: "configured" });
		expect(setup.received).toEqual([]);
	});

	it("routes resource/prompt methods through the manager for a selected server", async () => {
		const setup = createResourcePromptServer({
			pages: [{ resources: [{ uri: "file:///a", name: "A" }] }],
			readContents: [{ uri: "file:///a", text: "hello" }],
		});
		const manager = managerWith([{ id: "docs", transport: "stdio", command: "node" }], {
			selected: ["docs"],
			transportFactory: setup.transportFactory,
		});
		await manager.connect("docs");

		const listed = await manager.listResources("docs");
		expect(listed.resources[0].name).toBe("A");
		const read = await manager.readResource("docs", "file:///a");
		expect(read.contents[0]).toMatchObject({ kind: "text", text: "hello" });
		expect(read.provenance.untrusted).toBe(true);
		expect(manager.getStatus("docs")).toMatchObject({ state: "ready" });
	});

	it("resolves a listed resourceId to the in-memory URI without exposing the URI", async () => {
		const setup = createResourcePromptServer({
			pages: [{ resources: [{ uri: "file:///a", name: "A" }] }],
			readContents: [{ uri: "file:///a", text: "hello" }],
		});
		const manager = managerWith([{ id: "docs", transport: "stdio", command: "node" }], {
			selected: ["docs"],
			transportFactory: setup.transportFactory,
		});
		await manager.connect("docs");
		const listed = await manager.listResources("docs");
		const resourceId = listed.resources[0]!.resourceId;
		expect(resourceId).toBe(mcpResourceId("docs", "file:///a"));
		expect(manager.getResourceUri("docs", resourceId)).toBe("file:///a");
		const read = await manager.readResource("docs", resourceId);
		expect(read.resourceId).toBe(resourceId);
		expect(read.contents[0]).toMatchObject({ kind: "text", text: "hello" });
		expect(JSON.stringify(read)).not.toContain("file:///a");
	});
});

describe("per-session OAuth provider seam", () => {
	const provider: OAuthClientProvider = {
		get redirectUrl() {
			return "http://127.0.0.1:0/callback";
		},
		get clientMetadata() {
			return { redirect_uris: [new URL("http://127.0.0.1:0/callback")] } as never;
		},
		clientInformation: () => undefined,
		tokens: () => undefined,
		saveTokens: () => undefined,
		redirectToAuthorization: () => undefined,
		saveCodeVerifier: () => undefined,
		codeVerifier: () => "",
	};

	it("passes the per-session provider into the Streamable HTTP transport", () => {
		const transport = createMCPHttpTransport(
			{ id: "tracker", transport: "streamable-http", url: "https://mcp.invalid/mcp" },
			() => undefined,
			provider,
		);
		expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
		const internals = transport as unknown as { _authProvider?: unknown };
		expect(internals._authProvider).toBe(provider);
	});

	it("does not attach a provider when none is resolved", () => {
		const transport = createMCPHttpTransport(
			{ id: "tracker", transport: "streamable-http", url: "https://mcp.invalid/mcp" },
			() => undefined,
			() => undefined,
		);
		const internals = transport as unknown as { _authProvider?: unknown };
		expect(internals._authProvider).toBeUndefined();
	});

	it("resolves a per-config provider and hands it to the transport factory", async () => {
		const received: unknown[] = [];
		const setup = createResourcePromptServer();
		const lifecycle = new MCPServerLifecycle(
			{ id: "docs", transport: "streamable-http", url: "https://mcp.invalid/mcp" },
			{
				authProvider: (config) => {
					expect(config.id).toBe("docs");
					return provider;
				},
				transportFactory: async (_config, _env, authProvider) => {
					received.push(authProvider);
					return setup.transportFactory({ id: "docs", transport: "stdio", command: "node" });
				},
			},
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));
		await lifecycle.connect();
		expect(received).toEqual([provider]);
	});

	it("keeps auth_required classification when a provider is configured", async () => {
		const lifecycle = new MCPServerLifecycle(
			{ id: "docs", transport: "stdio", command: "node" },
			{
				authProvider: provider,
				transportFactory: async () =>
					new FailingUnauthorizedTransport(new UnauthorizedError("auth required secret-flow")),
			},
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));
		await expect(lifecycle.connect()).rejects.toMatchObject({
			kind: "auth_required",
			code: "capability_mcp_auth_required",
		});
		expect(JSON.stringify(lifecycle.getStatus())).not.toContain("secret-flow");
		expect(lifecycle.getStatus()).toMatchObject({ state: "unavailable" });
	});
});

class FailingUnauthorizedTransport implements Transport {
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	onmessage?: Transport["onmessage"];
	private readonly error: Error;

	constructor(error: Error) {
		this.error = error;
	}

	start(): Promise<void> {
		return Promise.reject(this.error);
	}

	async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}

	async close(): Promise<void> {}
}
