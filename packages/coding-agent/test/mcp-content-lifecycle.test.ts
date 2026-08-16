import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import {
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ReadResourceRequestSchema,
	type GetPromptResult,
	type ListPromptsResult,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type Prompt,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types";
import { MCPLifecycleManager, MCPServerLifecycle } from "../src/core/mcp-lifecycle.ts";
import {
	applyPageLimit,
	DEFAULT_MCP_CONTENT_LIMITS,
	DEFAULT_MCP_PAGE_LIMITS,
	mapPromptToView,
	mapResourceTemplateToView,
	mapResourceToView,
	normalizeContentBlocks,
	normalizeResourceContents,
	type MCPContentBlockInput,
	type MCPContentLimits,
	type MCPPageLimits,
} from "../src/core/mcp-content-types.ts";
import type { MCPServerConfig } from "../src/core/mcp-types.ts";

const STDIO_CONFIG: MCPServerConfig = { id: "docs", transport: "stdio", command: "node" };

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const RESOURCES: ReadonlyArray<Resource> = [
	{ uri: "file:///README.md", name: "readme", description: "project readme", mimeType: "text/markdown", size: 1024 },
	{ uri: "file:///logo.png", name: "logo", mimeType: "image/png" },
];

const TEMPLATES: ReadonlyArray<ResourceTemplate> = [
	{ uriTemplate: "file:///notes/{id}", name: "note template", description: "a note", mimeType: "text/plain" },
];

const PROMPTS: ReadonlyArray<Prompt> = [
	{
		name: "summarize",
		description: "summarize a resource",
		arguments: [
			{ name: "uri", description: "resource uri", required: true },
			{ name: "language", description: "output language" },
		],
	},
];

interface ContentServerHandlers {
	capabilities?: ServerCapabilities;
	resources?: ReadonlyArray<Resource>;
	resourceTemplates?: ReadonlyArray<ResourceTemplate>;
	prompts?: ReadonlyArray<Prompt>;
	listResourcesHandler?: (cursor: string | undefined) => ListResourcesResult | Promise<ListResourcesResult>;
	listTemplatesHandler?: (
		cursor: string | undefined,
	) => ListResourceTemplatesResult | Promise<ListResourceTemplatesResult>;
	listPromptsHandler?: (cursor: string | undefined) => ListPromptsResult | Promise<ListPromptsResult>;
	readResourceHandler?: (uri: string) => ReadResourceResult | Promise<ReadResourceResult>;
	getPromptHandler?: (name: string, args: unknown) => GetPromptResult | Promise<GetPromptResult>;
	/** When set, every request handler throws it. */
	requestError?: unknown;
	/** When true, every request handler blocks until releaseGate(). */
	holdRequests?: boolean;
}

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(
		serverCleanups
			.splice(0)
			.map((cleanup) => cleanup().catch(() => undefined)),
	);
});

/**
 * In-memory MCP server advertising resources and prompts, with per-method
 * override handlers, error injection, an optional global gate, and a log of
 * every request the lifecycle sends.
 */
function createContentServerFactory(opts: ContentServerHandlers = {}): {
	server: Server;
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	requests: Array<{ method: string; params: unknown }>;
	releaseGate: () => void;
} {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const capabilities = opts.capabilities ?? { resources: {}, prompts: {} };
	const server = new Server(
		{ name: "mock-content-server", version: "1.0.0" },
		{ capabilities },
	);
	const requests: Array<{ method: string; params: unknown }> = [];
	let releaseGate: (() => void) | undefined;
	const gate = opts.holdRequests
		? new Promise<void>((resolve) => {
				releaseGate = resolve;
			})
		: undefined;
	const maybeGate = async (): Promise<void> => {
		if (gate !== undefined) {
			await gate;
		}
	};

	// The SDK server refuses handlers for capabilities it does not advertise,
	// so handlers are registered only for advertised capabilities.
	if (capabilities.resources !== undefined) {
		server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
			requests.push({ method: "resources/list", params: request.params });
			await maybeGate();
			if (opts.requestError !== undefined) {
				throw opts.requestError;
			}
			if (opts.listResourcesHandler !== undefined) {
				return opts.listResourcesHandler(request.params?.cursor);
			}
			return { resources: [...(opts.resources ?? [])] };
		});

		server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
			requests.push({ method: "resources/templates/list", params: request.params });
			await maybeGate();
			if (opts.requestError !== undefined) {
				throw opts.requestError;
			}
			if (opts.listTemplatesHandler !== undefined) {
				return opts.listTemplatesHandler(request.params?.cursor);
			}
			return { resourceTemplates: [...(opts.resourceTemplates ?? [])] };
		});

		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			requests.push({ method: "resources/read", params: request.params });
			await maybeGate();
			if (opts.requestError !== undefined) {
				throw opts.requestError;
			}
			if (opts.readResourceHandler !== undefined) {
				return opts.readResourceHandler(request.params.uri);
			}
			return { contents: [{ uri: request.params.uri, text: `content of ${request.params.uri}` }] };
		});
	}

	if (capabilities.prompts !== undefined) {
		server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
			requests.push({ method: "prompts/list", params: request.params });
			await maybeGate();
			if (opts.requestError !== undefined) {
				throw opts.requestError;
			}
			if (opts.listPromptsHandler !== undefined) {
				return opts.listPromptsHandler(request.params?.cursor);
			}
			return { prompts: [...(opts.prompts ?? [])] };
		});

		server.setRequestHandler(GetPromptRequestSchema, async (request) => {
			requests.push({ method: "prompts/get", params: request.params });
			await maybeGate();
			if (opts.requestError !== undefined) {
				throw opts.requestError;
			}
			if (opts.getPromptHandler !== undefined) {
				return opts.getPromptHandler(request.params.name, request.params.arguments);
			}
			return {
				description: `prompt ${request.params.name}`,
				messages: [{ role: "user", content: { type: "text", text: `use ${request.params.name}` } }],
			};
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
		requests,
		releaseGate: () => releaseGate?.(),
	};
}

function lifecycleWith(opts: {
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	contentLimits?: MCPContentLimits;
	pageLimits?: MCPPageLimits;
}): MCPServerLifecycle {
	const lifecycle = new MCPServerLifecycle(STDIO_CONFIG, opts);
	serverCleanups.push(async () => {
		await lifecycle.forceClose().catch(() => undefined);
	});
	return lifecycle;
}

function managerWith(
	configs: ReadonlyArray<MCPServerConfig>,
	opts: {
		selected?: ReadonlyArray<string>;
		transportFactory?: (config: MCPServerConfig) => Promise<Transport>;
	} = {},
): MCPLifecycleManager {
	const manager = new MCPLifecycleManager({
		selectedServerIds: new Set(opts.selected ?? configs.map((config) => config.id)),
		...(opts.transportFactory !== undefined ? { transportFactory: opts.transportFactory } : {}),
	});
	manager.registerServers(configs);
	serverCleanups.push(async () => {
		await manager.closeAll().catch(() => undefined);
	});
	return manager;
}

const TINY_LIMITS: MCPContentLimits = { maxBlocks: 4, maxTextLength: 10, maxMediaBytes: 6 };
const TINY_PAGE: MCPPageLimits = { maxItemsPerPage: 1 };

describe("content normalizer", () => {
	it("passes text and small images through unchanged", () => {
		const content = normalizeContentBlocks(
			[
				{ type: "text", text: "hello" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			DEFAULT_MCP_CONTENT_LIMITS,
		);
		expect(content).toEqual({
			blocks: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			truncated: false,
			droppedBlocks: 0,
			droppedBytes: 0,
		});
	});

	it("truncates text over maxTextLength and flags the result", () => {
		const content = normalizeContentBlocks([{ type: "text", text: "0123456789ABCDEF" }], TINY_LIMITS);
		expect(content.blocks).toEqual([{ type: "text", text: "0123456789" }]);
		expect(content.truncated).toBe(true);
		expect(content.droppedBlocks).toBe(0);
	});

	it("drops oversized media whole and accounts the bytes", () => {
		const content = normalizeContentBlocks(
			[
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, // 8 bytes > 6
				{ type: "text", text: "ok" },
			],
			TINY_LIMITS,
		);
		expect(content.blocks).toEqual([{ type: "text", text: "ok" }]);
		expect(content.truncated).toBe(true);
		expect(content.droppedBlocks).toBe(1);
		expect(content.droppedBytes).toBe(8);
	});

	it("drops audio as unrepresentable without flagging truncation", () => {
		const content = normalizeContentBlocks(
			[{ type: "audio", data: "AAAA", mimeType: "audio/mpeg" }],
			DEFAULT_MCP_CONTENT_LIMITS,
		);
		expect(content.blocks).toEqual([]);
		expect(content.truncated).toBe(false);
		expect(content.droppedBlocks).toBe(1);
		expect(content.droppedBytes).toBe(4);
	});

	it("drops toolUse and toolResult transcript artifacts", () => {
		const content = normalizeContentBlocks(
			[
				{ type: "toolUse", id: "t1", name: "read" },
				{ type: "toolResult", toolCallId: "t1" },
				{ type: "text", text: "kept" },
			],
			DEFAULT_MCP_CONTENT_LIMITS,
		);
		expect(content.blocks).toEqual([{ type: "text", text: "kept" }]);
		expect(content.droppedBlocks).toBe(2);
	});

	it("converts resource blocks to text or image and drops other binary", () => {
		const content = normalizeContentBlocks(
			[
				{ type: "resource", resource: { uri: "note://1", text: "note text" } },
				{ type: "resource", resource: { uri: "img://1", blob: "aGVsbG8=", mimeType: "image/png" } },
				{ type: "resource", resource: { uri: "bin://1", blob: "AAAA", mimeType: "application/octet-stream" } },
				{ type: "resource", resource: { uri: "empty://1" } },
			],
			DEFAULT_MCP_CONTENT_LIMITS,
		);
		expect(content.blocks).toEqual([
			{ type: "text", text: "note text" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		expect(content.droppedBlocks).toBe(2);
		expect(content.droppedBytes).toBe(4);
	});

	it("caps the total block count and counts the dropped tail", () => {
		const blocks: MCPContentBlockInput[] = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
			{ type: "text", text: "c" },
			{ type: "text", text: "d" },
			{ type: "text", text: "e" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		const content = normalizeContentBlocks(blocks, TINY_LIMITS);
		expect(content.blocks).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
			{ type: "text", text: "c" },
			{ type: "text", text: "d" },
		]);
		expect(content.truncated).toBe(true);
		expect(content.droppedBlocks).toBe(2);
		expect(content.droppedBytes).toBe(4);
	});

	it("normalizes resource read contents, keeping only text and image blobs", () => {
		const content = normalizeResourceContents(
			[
				{ uri: "file:///a.txt", text: "hello", mimeType: "text/plain" },
				{ uri: "file:///a.png", blob: "aGVsbG8=", mimeType: "image/png" },
				{ uri: "file:///a.bin", blob: "AAAA", mimeType: "application/octet-stream" },
			],
			DEFAULT_MCP_CONTENT_LIMITS,
		);
		expect(content.blocks).toEqual([
			{ type: "text", text: "hello" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		expect(content.droppedBlocks).toBe(1);
	});

	it("returns an empty, untruncated result for no input", () => {
		expect(normalizeContentBlocks([], DEFAULT_MCP_CONTENT_LIMITS)).toEqual({
			blocks: [],
			truncated: false,
			droppedBlocks: 0,
			droppedBytes: 0,
		});
	});

	it("applies the page cap and drops the cursor of an over-limit page", () => {
		expect(applyPageLimit(["a", "b"], "next", TINY_PAGE)).toEqual({ items: ["a"], truncated: true });
		expect(applyPageLimit(["a"], "next", TINY_PAGE)).toEqual({ items: ["a"], nextCursor: "next", truncated: false });
		expect(applyPageLimit([], undefined, TINY_PAGE)).toEqual({ items: [], truncated: false });
	});

	it("maps resources, templates, and prompts to secret-free views", () => {
		expect(mapResourceToView(RESOURCES[0])).toEqual({
			uri: "file:///README.md",
			name: "readme",
			description: "project readme",
			mimeType: "text/markdown",
			size: 1024,
		});
		expect(mapResourceToView(RESOURCES[1])).toEqual({ uri: "file:///logo.png", name: "logo", mimeType: "image/png" });
		expect(mapResourceTemplateToView(TEMPLATES[0])).toEqual({
			uriTemplate: "file:///notes/{id}",
			name: "note template",
			description: "a note",
			mimeType: "text/plain",
		});
		expect(mapPromptToView(PROMPTS[0])).toEqual({
			name: "summarize",
			description: "summarize a resource",
			arguments: [
				{ name: "uri", description: "resource uri", required: true },
				{ name: "language", description: "output language" },
			],
		});
	});
});

describe("MCP resource lifecycle", () => {
	it("lists resources, forwards the cursor, and reports the page count", async () => {
		const setup = createContentServerFactory({
			listResourcesHandler: (cursor) =>
				cursor === undefined
					? { resources: [RESOURCES[0]], nextCursor: "page-2" }
					: { resources: [RESOURCES[1]] },
		});
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const page1 = await lifecycle.listResources();
		expect(page1).toEqual({
			items: [
				{
					uri: "file:///README.md",
					name: "readme",
					description: "project readme",
					mimeType: "text/markdown",
					size: 1024,
				},
			],
			nextCursor: "page-2",
			truncated: false,
		});
		expect(lifecycle.getStatus().resourceCount).toBe(1);

		const page2 = await lifecycle.listResources("page-2");
		expect(page2.items).toEqual([{ uri: "file:///logo.png", name: "logo", mimeType: "image/png" }]);
		expect(page2.nextCursor).toBeUndefined();

		expect(setup.requests.map((request) => request.params)).toEqual([{}, { cursor: "page-2" }]);
	});

	it("cuts an over-limit server page and stops pagination", async () => {
		const setup = createContentServerFactory({
			listResourcesHandler: () => ({ resources: [RESOURCES[0], RESOURCES[1]], nextCursor: "page-2" }),
		});
		const lifecycle = lifecycleWith({
			transportFactory: setup.transportFactory,
			pageLimits: { maxItemsPerPage: 1 },
		});
		await lifecycle.connect();

		const page = await lifecycle.listResources();
		expect(page.items).toEqual([
			{ uri: "file:///README.md", name: "readme", description: "project readme", mimeType: "text/markdown", size: 1024 },
		]);
		expect(page.nextCursor).toBeUndefined();
		expect(page.truncated).toBe(true);
	});

	it("lists resource templates", async () => {
		const setup = createContentServerFactory({
			listTemplatesHandler: () => ({ resourceTemplates: [TEMPLATES[0]] }),
		});
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const result = await lifecycle.listResourceTemplates();
		expect(result).toEqual({
			items: [
				{
					uriTemplate: "file:///notes/{id}",
					name: "note template",
					description: "a note",
					mimeType: "text/plain",
				},
			],
			truncated: false,
		});
	});

	it("reads a resource and normalizes its contents under the configured limits", async () => {
		const setup = createContentServerFactory({
			readResourceHandler: (uri) => ({
				contents: [
					{ uri, text: "0123456789ABCDEF" },
					{ uri, blob: "aGVsbG8=", mimeType: "image/png" },
				],
			}),
		});
		const lifecycle = lifecycleWith({
			transportFactory: setup.transportFactory,
			contentLimits: { maxBlocks: 4, maxTextLength: 10, maxMediaBytes: 100 },
		});
		await lifecycle.connect();

		const result = await lifecycle.readResource("file:///note");
		expect(result).toEqual({
			serverId: "docs",
			uri: "file:///note",
			content: {
				blocks: [
					{ type: "text", text: "0123456789" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				truncated: true,
				droppedBlocks: 0,
				droppedBytes: 0,
			},
		});
		expect(setup.requests[0].params).toEqual({ uri: "file:///note" });
	});

	it("rejects reads and lists when the server does not advertise resources, without degrading", async () => {
		const setup = createContentServerFactory({ capabilities: { prompts: {} } });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		await expect(lifecycle.listResources()).rejects.toMatchObject({
			kind: "unavailable",
			code: "capability_mcp_unavailable",
			message: expect.stringContaining('does not advertise the "resources" capability'),
		});
		await expect(lifecycle.readResource("file:///x")).rejects.toMatchObject({
			kind: "unavailable",
			message: expect.stringContaining('does not advertise the "resources" capability'),
		});
		expect(lifecycle.state).toBe("ready");
		expect(setup.requests).toEqual([]);
	});

	it("rejects an empty resource uri locally", async () => {
		const setup = createContentServerFactory();
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		await expect(lifecycle.readResource("")).rejects.toMatchObject({
			kind: "invalid_config",
			code: "capability_denied",
		});
		expect(lifecycle.state).toBe("ready");
		expect(setup.requests).toEqual([]);
	});
});

describe("MCP prompt lifecycle", () => {
	it("lists prompts and reports the page count", async () => {
		const setup = createContentServerFactory({ prompts: PROMPTS });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const result = await lifecycle.listPrompts();
		expect(result.items).toEqual([
			{
				name: "summarize",
				description: "summarize a resource",
				arguments: [
					{ name: "uri", description: "resource uri", required: true },
					{ name: "language", description: "output language" },
				],
			},
		]);
		expect(result.truncated).toBe(false);
		expect(lifecycle.getStatus().promptCount).toBe(1);
	});

	it("fetches a prompt, forwards arguments, and normalizes message content", async () => {
		const setup = createContentServerFactory({
			getPromptHandler: (name, args) => ({
				description: `prompt ${name}`,
				messages: [
					{ role: "user", content: { type: "text", text: "0123456789ABCDEF" } },
					{ role: "assistant", content: { type: "text", text: "ok" } },
				],
				...(args !== undefined ? { _meta: { echoed: args } } : {}),
			}),
		});
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory, contentLimits: TINY_LIMITS });
		await lifecycle.connect();

		const result = await lifecycle.getPrompt("summarize", { uri: "file:///note", language: "en" });
		expect(result.serverId).toBe("docs");
		expect(result.promptName).toBe("summarize");
		expect(result.description).toBe("prompt summarize");
		expect(result.messages).toEqual([
			{
				role: "user",
				content: {
					blocks: [{ type: "text", text: "0123456789" }],
					truncated: true,
					droppedBlocks: 0,
					droppedBytes: 0,
				},
			},
			{
				role: "assistant",
				content: { blocks: [{ type: "text", text: "ok" }], truncated: false, droppedBlocks: 0, droppedBytes: 0 },
			},
		]);
		expect(setup.requests[0].params).toEqual({
			name: "summarize",
			arguments: { uri: "file:///note", language: "en" },
		});
	});

	it("rejects invalid prompt names without contacting the server", async () => {
		const setup = createContentServerFactory();
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		for (const name of ["", "a__b", "a b", "a:b"]) {
			await expect(lifecycle.getPrompt(name)).rejects.toMatchObject({
				kind: "invalid_config",
				code: "capability_denied",
			});
		}
		expect(lifecycle.state).toBe("ready");
		expect(setup.requests).toEqual([]);
	});

	it("rejects prompt operations when the server does not advertise prompts, without degrading", async () => {
		const setup = createContentServerFactory({ capabilities: { resources: {} } });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		await expect(lifecycle.listPrompts()).rejects.toMatchObject({
			kind: "unavailable",
			message: expect.stringContaining('does not advertise the "prompts" capability'),
		});
		await expect(lifecycle.getPrompt("summarize")).rejects.toMatchObject({
			kind: "unavailable",
			message: expect.stringContaining('does not advertise the "prompts" capability'),
		});
		expect(lifecycle.state).toBe("ready");
		expect(setup.requests).toEqual([]);
	});
});

describe("cancellation, teardown, and stale/degraded handling", () => {
	it("aborts an in-flight read with AbortError without degrading the server", async () => {
		const setup = createContentServerFactory({ holdRequests: true });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const controller = new AbortController();
		const readPromise = lifecycle.readResource("file:///slow", controller.signal);
		await waitUntil(() => setup.requests.length === 1);

		controller.abort();
		await expect(readPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(lifecycle.state).toBe("ready");

		setup.releaseGate();
	});

	it("aborts an in-flight listing with AbortError without degrading the server", async () => {
		const setup = createContentServerFactory({ holdRequests: true });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const controller = new AbortController();
		const listPromise = lifecycle.listPrompts(undefined, controller.signal);
		await waitUntil(() => setup.requests.length === 1);

		controller.abort();
		await expect(listPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(lifecycle.state).toBe("ready");

		setup.releaseGate();
	});

	it("rejects a read when the signal is already aborted", async () => {
		const setup = createContentServerFactory();
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const controller = new AbortController();
		controller.abort();
		await expect(lifecycle.readResource("file:///x", controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(lifecycle.state).toBe("ready");
		expect(setup.requests).toEqual([]);
	});

	it("force-closes an in-flight read and ends in the closed state", async () => {
		const setup = createContentServerFactory({ holdRequests: true });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const readPromise = lifecycle.readResource("file:///slow");
		await waitUntil(() => setup.requests.length === 1);

		const forceClosePromise = lifecycle.forceClose();
		await expect(readPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await forceClosePromise;
		expect(lifecycle.state).toBe("closed");
		expect(lifecycle.getStatus().availability).toBe("unavailable");

		await expect(lifecycle.readResource("file:///slow")).rejects.toMatchObject({
			code: "capability_mcp_unavailable",
		});
		setup.releaseGate();
	});

	it("degrades the server on a read failure and refuses later content operations", async () => {
		const secret = "read exploded: sk-super-secret-token";
		const setup = createContentServerFactory({ requestError: new Error(secret) });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		await expect(lifecycle.readResource("file:///x")).rejects.toMatchObject({
			kind: "unavailable",
			code: "capability_mcp_unavailable",
		});
		expect(lifecycle.state).toBe("degraded");
		const status = lifecycle.getStatus();
		expect(status.lastError).toMatchObject({ kind: "unavailable", code: "capability_mcp_unavailable" });
		const serialized = JSON.stringify(status);
		expect(serialized).not.toContain("exploded");
		expect(serialized).not.toContain("sk-super-secret-token");

		await expect(lifecycle.listResources()).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await expect(lifecycle.getPrompt("summarize")).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
	});

	it("degrades when the transport drops while a read is in flight", async () => {
		const setup = createContentServerFactory({ holdRequests: true });
		const lifecycle = lifecycleWith({ transportFactory: setup.transportFactory });
		await lifecycle.connect();

		const readPromise = lifecycle.readResource("file:///slow");
		await waitUntil(() => setup.requests.length === 1);

		await setup.server.close();
		await expect(readPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await waitUntil(() => lifecycle.state === "degraded");
		expect(lifecycle.getStatus().availability).toBe("degraded");

		setup.releaseGate();
	});

	it("rejects an in-flight read when the server is deselected, and re-selection reconnects fresh", async () => {
		const first = createContentServerFactory({ holdRequests: true });
		const second = createContentServerFactory();
		let calls = 0;
		const transportFactory = async (config: MCPServerConfig): Promise<Transport> => {
			calls += 1;
			return calls === 1 ? first.transportFactory(config) : second.transportFactory(config);
		};
		const manager = managerWith([STDIO_CONFIG], { transportFactory });
		await manager.connect("docs");

		const readPromise = manager.readResource("docs", "file:///slow");
		await waitUntil(() => first.requests.length === 1);

		await manager.setSelectedServerIds([]);
		await expect(readPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		expect(manager.getStatus("docs")?.state).toBe("closed");

		// Re-selecting and reconnecting uses a fresh connection; the held request
		// stays rejected and never resolves stale content.
		await manager.setSelectedServerIds(["docs"]);
		await manager.connect("docs");
		expect(manager.getStatus("docs")?.state).toBe("ready");
		const fresh = await manager.listResources("docs");
		expect(fresh.items).toEqual([]);

		first.releaseGate();
	});

	it("discards results from a superseded connection after reconnect", async () => {
		const first = createContentServerFactory({ holdRequests: true });
		const second = createContentServerFactory();
		let calls = 0;
		const transportFactory = async (config: MCPServerConfig): Promise<Transport> => {
			calls += 1;
			return calls === 1 ? first.transportFactory(config) : second.transportFactory(config);
		};
		const lifecycle = lifecycleWith({ transportFactory });
		await lifecycle.connect();

		const readPromise = lifecycle.readResource("file:///slow");
		await waitUntil(() => first.requests.length === 1);

		// Tear down the connection while the read is in flight, then reconnect:
		// the in-flight read must reject and never resolve stale content from
		// the superseded connection.
		await lifecycle.close();
		await expect(readPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await lifecycle.connect();
		expect(calls).toBe(2);
		expect(lifecycle.state).toBe("ready");

		const result = await lifecycle.readResource("file:///fresh");
		expect(result.uri).toBe("file:///fresh");
		expect(result.content.blocks).toEqual([{ type: "text", text: "content of file:///fresh" }]);

		first.releaseGate();
	});

	it("reconnects explicitly after degradation and serves content again", async () => {
		const broken = createContentServerFactory({ requestError: new Error("first connection broken") });
		const healthy = createContentServerFactory();
		let calls = 0;
		const transportFactory = async (config: MCPServerConfig): Promise<Transport> => {
			calls += 1;
			return calls === 1 ? broken.transportFactory(config) : healthy.transportFactory(config);
		};
		const lifecycle = lifecycleWith({ transportFactory });
		await lifecycle.connect();

		await expect(lifecycle.listResources()).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		expect(lifecycle.state).toBe("degraded");

		// A degraded server never auto-reconnects; an explicit connect restores
		// service on a fresh connection.
		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");
		await expect(lifecycle.listResources()).resolves.toMatchObject({ truncated: false });
	});
});

describe("selected binding gates for content operations", () => {
	it("refuses list, read, and prompt operations on unselected servers", async () => {
		const setup = createContentServerFactory();
		const manager = managerWith([STDIO_CONFIG], { selected: [], transportFactory: setup.transportFactory });

		await expect(manager.listResources("docs")).rejects.toMatchObject({
			kind: "not_selected",
			code: "capability_denied",
		});
		await expect(manager.listResourceTemplates("docs")).rejects.toMatchObject({ kind: "not_selected" });
		await expect(manager.readResource("docs", "file:///x")).rejects.toMatchObject({ kind: "not_selected" });
		await expect(manager.listPrompts("docs")).rejects.toMatchObject({ kind: "not_selected" });
		await expect(manager.getPrompt("docs", "summarize")).rejects.toMatchObject({ kind: "not_selected" });
		expect(setup.requests).toEqual([]);
	});

	it("delegates content operations for a selected server", async () => {
		const setup = createContentServerFactory({
			resources: RESOURCES,
			resourceTemplates: TEMPLATES,
			prompts: PROMPTS,
			readResourceHandler: (uri) => ({ contents: [{ uri, text: "delegated" }] }),
			getPromptHandler: (name) => ({
				messages: [{ role: "user", content: { type: "text", text: `use ${name}` } }],
			}),
		});
		const manager = managerWith([STDIO_CONFIG], { transportFactory: setup.transportFactory });
		await manager.connect("docs");

		await expect(manager.listResources("docs")).resolves.toMatchObject({ truncated: false });
		await expect(manager.listResourceTemplates("docs")).resolves.toMatchObject({ truncated: false });
		await expect(manager.readResource("docs", "file:///x")).resolves.toMatchObject({
			serverId: "docs",
			uri: "file:///x",
		});
		await expect(manager.listPrompts("docs")).resolves.toMatchObject({ truncated: false });
		await expect(manager.getPrompt("docs", "summarize")).resolves.toMatchObject({
			serverId: "docs",
			promptName: "summarize",
		});
	});

	it("refuses content operations for an unregistered server id", async () => {
		const manager = managerWith([], {});
		await expect(manager.readResource("unknown", "file:///x")).rejects.toMatchObject({
			kind: "invalid_config",
			code: "capability_denied",
		});
	});
});

describe("content defaults", () => {
	it("exposes finite, positive default limits", () => {
		expect(DEFAULT_MCP_CONTENT_LIMITS.maxBlocks).toBeGreaterThan(0);
		expect(DEFAULT_MCP_CONTENT_LIMITS.maxTextLength).toBeGreaterThan(0);
		expect(DEFAULT_MCP_CONTENT_LIMITS.maxMediaBytes).toBeGreaterThan(0);
		expect(DEFAULT_MCP_PAGE_LIMITS.maxItemsPerPage).toBeGreaterThan(0);
	});
});
