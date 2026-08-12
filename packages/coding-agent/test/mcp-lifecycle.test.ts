import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport";
import {
	CallToolRequestSchema,
	type CallToolResult,
	type JSONRPCMessage,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types";
import {
	createMCPHttpTransport,
	createMCPStdioTransport,
	MCPLifecycleManager,
	MCPServerLifecycle,
} from "../src/core/mcp-lifecycle.ts";
import {
	createMCPServerConfigView,
	MCPError,
	mcpErrorKindToCapabilityCode,
	type MCPEnvResolver,
	type MCPErrorKind,
	type MCPServerConfig,
	mcpStateToAvailability,
	redactMCPUrl,
	validateMCPServerConfig,
} from "../src/core/mcp-types.ts";

const STDIO_CONFIG: MCPServerConfig = { id: "docs", transport: "stdio", command: "node" };

/** Config for a transport type; HTTP uses a reserved/invalid host so no real network is ever contacted. */
function configFor(transport: "stdio" | "streamable-http"): MCPServerConfig {
	return transport === "stdio"
		? { id: "docs", transport: "stdio", command: "node" }
		: { id: "docs", transport: "streamable-http", url: "https://mcp.invalid/mcp" };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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

interface MockServerHandlers {
	tools?: ReadonlyArray<Tool>;
	listToolsError?: unknown;
	/** When set, tool calls block until releaseCallGate() is invoked. */
	holdCalls?: boolean;
	callHandler?: (name: string, args: unknown) => CallToolResult | Promise<CallToolResult>;
}

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(
		serverCleanups
			.splice(0)
			.map((cleanup) => cleanup().catch(() => undefined)),
	);
});

function createMockServerFactory(opts: MockServerHandlers = {}): {
	server: Server;
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	receivedCalls: Array<{ name: string; args: unknown }>;
	releaseCallGate: () => void;
} {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });
	const receivedCalls: Array<{ name: string; args: unknown }> = [];

	let releaseCallGate: (() => void) | undefined;
	const callGate = opts.holdCalls
		? new Promise<void>((resolve) => {
				releaseCallGate = resolve;
			})
		: undefined;

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		if (opts.listToolsError !== undefined) {
			throw opts.listToolsError;
		}
		return { tools: [...(opts.tools ?? [])] };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = request.params.name;
		const args = request.params.arguments;
		receivedCalls.push({ name, args });
		if (callGate !== undefined) {
			await callGate;
		}
		if (opts.callHandler !== undefined) {
			return opts.callHandler(name, args);
		}
		return { content: [{ type: "text", text: `ok:${name}` }] };
	});

	const serverReady = server.connect(serverTransport);
	serverReady.catch(() => undefined);

	serverCleanups.push(async () => {
		await server.close().catch(() => undefined);
		await clientTransport.close().catch(() => undefined);
	});

	return {
		server,
		transportFactory: async () => clientTransport,
		receivedCalls,
		releaseCallGate: () => releaseCallGate?.(),
	};
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

/**
 * Creates one in-memory mock server per server id and routes the factory by
 * config, so closing one server's transport cannot tear down another server's
 * shared in-memory connection.
 */
function multiServerFactory(
	ids: ReadonlyArray<string>,
	opts: MockServerHandlers = {},
): (config: MCPServerConfig) => Promise<Transport> {
	const setups = new Map(ids.map((id) => [id, createMockServerFactory(opts)]));
	return async (config) => setups.get(config.id)!.transportFactory(config);
}

/**
 * Creates a fresh in-memory server + transport pair on every factory call, so a
 * reconnected server gets a brand-new transport (and server) instead of reusing
 * a transport that was already closed by a previous deselection.
 */
function freshPairFactory(opts: MockServerHandlers = {}): {
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	serverCount: () => number;
} {
	let count = 0;
	const transportFactory = async (config: MCPServerConfig): Promise<Transport> => {
		count += 1;
		const setup = createMockServerFactory(opts);
		return setup.transportFactory(config);
	};
	return { transportFactory, serverCount: () => count };
}

/**
 * Transport wrapper that holds a close until released, so tests can observe
 * that a deselection promise does not settle before the transport is actually
 * released and that a removed server's transport is torn down exactly once.
 * Handler assignments are forwarded to the wrapped transport so the SDK client
 * and lifecycle install their message handlers on it as usual.
 */
class GatedCloseTransport implements Transport {
	private readonly inner: Transport;
	closeInvocations = 0;
	private closeGate: Promise<void> | undefined;
	private releaseClose: (() => void) | undefined;

	constructor(inner: Transport) {
		this.inner = inner;
		this.holdClose();
	}

	get onclose(): Transport["onclose"] | undefined {
		return this.inner.onclose;
	}
	set onclose(value: Transport["onclose"] | undefined) {
		this.inner.onclose = value;
	}
	get onerror(): Transport["onerror"] | undefined {
		return this.inner.onerror;
	}
	set onerror(value: Transport["onerror"] | undefined) {
		this.inner.onerror = value;
	}
	get onmessage(): Transport["onmessage"] | undefined {
		return this.inner.onmessage;
	}
	set onmessage(value: Transport["onmessage"] | undefined) {
		this.inner.onmessage = value;
	}

	async start(): Promise<void> {
		return this.inner.start();
	}

	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		return this.inner.send(message, options);
	}

	holdClose(): void {
		if (this.closeGate === undefined) {
			this.closeGate = new Promise<void>((resolve) => {
				this.releaseClose = resolve;
			});
		}
	}

	releaseCloseGate(): void {
		this.releaseClose?.();
	}

	async close(): Promise<void> {
		this.closeInvocations += 1;
		if (this.closeGate !== undefined) {
			await this.closeGate;
		}
		await this.inner.close();
	}
}

/**
 * Transport wrapper that intercepts the lifecycle's onclose handler and lets the
 * test fire it manually, simulating a transport whose close notification arrives
 * asynchronously long after close() returned (like a delayed child-process
 * exit), so a stale transport can be proven not to revive a reconnected
 * lifecycle. Message and error handlers are forwarded to the inner transport so
 * the SDK client and lifecycle install their handlers on it as usual.
 */
class ManualOnCloseTransport implements Transport {
	private readonly inner: Transport;
	private closeHandler: Transport["onclose"] | undefined;
	closeInvocations = 0;

	constructor(inner: Transport) {
		this.inner = inner;
	}

	get onclose(): Transport["onclose"] | undefined {
		return this.closeHandler;
	}
	set onclose(value: Transport["onclose"] | undefined) {
		this.closeHandler = value;
	}
	get onerror(): Transport["onerror"] | undefined {
		return this.inner.onerror;
	}
	set onerror(value: Transport["onerror"] | undefined) {
		this.inner.onerror = value;
	}
	get onmessage(): Transport["onmessage"] | undefined {
		return this.inner.onmessage;
	}
	set onmessage(value: Transport["onmessage"] | undefined) {
		this.inner.onmessage = value;
	}

	async start(): Promise<void> {
		return this.inner.start();
	}

	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		return this.inner.send(message, options);
	}

	async close(): Promise<void> {
		this.closeInvocations += 1;
		await this.inner.close();
	}

	/** Fires the lifecycle's onclose handler as if the transport finally noticed it closed. */
	fireClose(): void {
		this.closeHandler?.();
	}
}

/** Wraps a transport factory so every transport it creates gates close until released. */
function gateCloseFactory(
	factory: (config: MCPServerConfig) => Promise<Transport>,
): {
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	transportCount: () => number;
	closeCount: () => number;
	releaseAll: () => void;
} {
	const held: GatedCloseTransport[] = [];
	const transportFactory = async (config: MCPServerConfig): Promise<Transport> => {
		const inner = await factory(config);
		const gated = new GatedCloseTransport(inner);
		held.push(gated);
		return gated;
	};
	return {
		transportFactory,
		transportCount: () => held.length,
		closeCount: () => held.reduce((count, gated) => count + gated.closeInvocations, 0),
		releaseAll: () => {
			for (const gated of held) {
				gated.releaseCloseGate();
			}
		},
	};
}

describe("mcp-types error mapping and redaction", () => {
	it("maps lifecycle failure kinds to canonical capability error codes", () => {
		expect(mcpErrorKindToCapabilityCode("connect_failed")).toBe("capability_mcp_connect_failed");
		expect(mcpErrorKindToCapabilityCode("auth_required")).toBe("capability_mcp_auth_required");
		expect(mcpErrorKindToCapabilityCode("unavailable")).toBe("capability_mcp_unavailable");
		expect(mcpErrorKindToCapabilityCode("call_failed")).toBe("capability_mcp_unavailable");
		expect(mcpErrorKindToCapabilityCode("not_selected")).toBe("capability_denied");
		expect(mcpErrorKindToCapabilityCode("invalid_config")).toBe("capability_denied");
	});

	it("never retains a raw cause, so JSON and Node error inspection stay secret-free", () => {
		const secret = "remote-secret-token-abc123";
		// The constructor does not accept or store a raw cause. Pass one anyway
		// (the way the old lifecycle did) via a widened constructor type and prove
		// it is ignored: Node's error inspection, including util.inspect with
		// showHidden, would otherwise surface non-enumerable properties such as
		// Error.cause.
		const Ctor = MCPError as unknown as new (
			kind: MCPErrorKind,
			serverId: string,
			message: string,
			cause?: unknown,
		) => MCPError;
		const error = new Ctor("connect_failed", "docs", 'Failed to connect to MCP server "docs"', {
			message: secret,
		});
		const serialized = JSON.stringify(error);
		const inspected = inspect(error, { showHidden: true, depth: 5 });
		expect(serialized).not.toContain(secret);
		expect(inspected).not.toContain(secret);
		expect("cause" in error).toBe(false);
		expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
		expect(serialized).toContain("capability_mcp_connect_failed");
	});

	it("maps connection states to fail-closed availability", () => {
		expect(mcpStateToAvailability("ready")).toBe("available");
		expect(mcpStateToAvailability("degraded")).toBe("degraded");
		expect(mcpStateToAvailability("configured")).toBe("unavailable");
		expect(mcpStateToAvailability("connecting")).toBe("unavailable");
		expect(mcpStateToAvailability("unavailable")).toBe("unavailable");
		expect(mcpStateToAvailability("closing")).toBe("unavailable");
		expect(mcpStateToAvailability("closed")).toBe("unavailable");
	});

	it("redacts URL userinfo and query but keeps the path", () => {
		expect(redactMCPUrl("https://user:pass@host.example/mcp?token=sk-leak")).toBe("https://host.example/mcp");
		expect(redactMCPUrl("https://host.example/mcp?token=sk-leak#frag")).toBe("https://host.example/mcp");
		expect(redactMCPUrl("not-a-url")).toBe("<invalid-url>");
	});

	it("rejects empty and double-underscore namespace segments", () => {
		const problems = (config: MCPServerConfig): string[] => [...validateMCPServerConfig(config)];
		expect(problems({ id: "", transport: "stdio", command: "node" })).toContain("server id must not be empty");
		expect(problems({ id: "a__b", transport: "stdio", command: "node" })).toContain(
			"server id must not contain a double underscore",
		);
		expect(problems({ id: "a b", transport: "stdio", command: "node" })).toContain(
			"server id must not contain whitespace or ':'",
		);
		expect(problems({ id: "a:b", transport: "stdio", command: "node" })).toContain(
			"server id must not contain whitespace or ':'",
		);
		expect(problems({ id: "ok", transport: "stdio", command: "" })).toContain("stdio command must not be empty");
		expect(problems({ id: "ok", transport: "stdio", command: "   " })).toContain(
			"stdio command must not be empty",
		);
		expect(problems({ id: "ok", transport: "stdio", command: "node" })).toEqual([]);
	});

	it("rejects bare credential query keys, non-http/https urls, and empty hosts", () => {
		const http = (url: string): MCPServerConfig => ({ id: "srv", transport: "streamable-http", url });
		expect(validateMCPServerConfig(http("https://user:pass@host/mcp"))).toContain(
			"url must not contain userinfo",
		);
		expect(validateMCPServerConfig(http("https://host/mcp?token=abc"))).toContain(
			"url query must not contain credentials",
		);
		expect(validateMCPServerConfig(http("https://host/mcp?api_key=abc"))).toContain(
			"url query must not contain credentials",
		);
		// bare credential keys with no value are still rejected
		expect(validateMCPServerConfig(http("https://host/mcp?token"))).toContain(
			"url query must not contain credentials",
		);
		expect(validateMCPServerConfig(http("https://host/mcp?api_key"))).toContain(
			"url query must not contain credentials",
		);
		expect(validateMCPServerConfig(http("https://host/mcp?key"))).toContain(
			"url query must not contain credentials",
		);
		// a plain "key" query name with a value is rejected too
		expect(validateMCPServerConfig(http("https://host/mcp?key=abc"))).toContain(
			"url query must not contain credentials",
		);
		expect(validateMCPServerConfig(http("not a url"))).toContain("url is not a valid URL");
		expect(validateMCPServerConfig(http("ftp://host/mcp"))).toContain("url must use http or https");
		expect(validateMCPServerConfig(http("file:///etc/passwd"))).toContain("url must use http or https");
		expect(validateMCPServerConfig(http("file:///etc/passwd"))).toContain("url must have a host");
		expect(validateMCPServerConfig(http("https://host/mcp?page=1"))).toEqual([]);
	});

	it("never exposes argv, cwd, env values, header values, or tokens in config views", () => {
		const stdioView = createMCPServerConfigView({
			id: "docs",
			transport: "stdio",
			command: "node",
			args: ["--token", "sk-secret", "--path", "/secret/dir"],
			cwd: "/secret/workdir",
			env: ["DOCS_TOKEN", "PATH"],
		});
		expect(stdioView).toEqual({ id: "docs", transport: "stdio", command: "node", envNames: ["DOCS_TOKEN", "PATH"] });
		expect(JSON.stringify(stdioView)).not.toContain("sk-secret");
		expect(JSON.stringify(stdioView)).not.toContain("/secret/workdir");
		expect(JSON.stringify(stdioView)).not.toContain("--token");

		const httpView = createMCPServerConfigView({
			id: "tracker",
			transport: "streamable-http",
			url: "https://user:pass@host.example/mcp?token=sk-query",
			headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
		});
		expect(httpView).toEqual({
			id: "tracker",
			transport: "streamable-http",
			url: "https://host.example/mcp",
			headerNames: ["Authorization"],
			envNames: ["ISSUE_TRACKER_TOKEN"],
		});
		const serialized = JSON.stringify(httpView);
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("sk-query");
		expect(serialized).not.toContain("Authorization: Bearer");
	});
});

describe("transport factories", () => {
	it("builds a stdio transport resolving only allowlisted env names", () => {
		const resolved: string[] = [];
		const env: MCPEnvResolver = (name) => {
			resolved.push(name);
			return name === "DOCS_TOKEN" ? "secret-value" : undefined;
		};
		const transport = createMCPStdioTransport(
			{ id: "docs", transport: "stdio", command: "node", args: ["srv.js"], env: ["DOCS_TOKEN"] },
			env,
		);
		expect(transport).toBeInstanceOf(StdioClientTransport);
		expect(resolved).toEqual(["DOCS_TOKEN"]);
		const serverParams = (
			transport as unknown as { _serverParams?: { env?: Record<string, string> } }
		)._serverParams;
		expect(serverParams?.env?.DOCS_TOKEN).toBe("secret-value");
		expect(serverParams?.env?.PATH).toBe("");
	});

	it("builds a streamable http transport resolving only the referenced env names", () => {
		const resolved: string[] = [];
		const env: MCPEnvResolver = (name) => {
			resolved.push(name);
			return name === "ISSUE_TRACKER_TOKEN" ? "secret-value" : undefined;
		};
		const transport = createMCPHttpTransport(
			{
				id: "tracker",
				transport: "streamable-http",
				url: "https://host.example/mcp",
				headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
			},
			env,
		);
		expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
		expect(resolved).toEqual(["ISSUE_TRACKER_TOKEN"]);
	});
});

describe("MCP lifecycle state machine with in-memory transport", () => {
	it("moves configured -> connecting -> ready -> closing -> closed", async () => {
		const setup = createMockServerFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const lifecycle = new MCPServerLifecycle(
			{ ...STDIO_CONFIG, id: "docs" },
			{ transportFactory: setup.transportFactory },
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));

		expect(lifecycle.state).toBe("configured");
		expect(lifecycle.getStatus()).toMatchObject({ state: "configured", availability: "unavailable" });

		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");
		expect(lifecycle.getStatus()).toMatchObject({ state: "ready", availability: "available" });
		expect(lifecycle.getStatus().connectedAt).toBeDefined();

		const tools = await lifecycle.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);
		expect(lifecycle.getStatus().toolCount).toBe(1);

		await lifecycle.close();
		expect(lifecycle.state).toBe("closed");
		expect(lifecycle.getStatus()).toMatchObject({ state: "closed", availability: "unavailable" });
	});

	it("does not install a client when close races with connection setup", async () => {
		const setup = createMockServerFactory();
		let releaseFactory: (() => void) | undefined;
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const lifecycle = new MCPServerLifecycle(
			{ ...STDIO_CONFIG, id: "docs" },
			{
				transportFactory: async (config, env) => {
					await factoryGate;
					return setup.transportFactory(config);
				},
			},
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));

		const connectPromise = lifecycle.connect();
		await waitUntil(() => lifecycle.state === "connecting");
		const closePromise = lifecycle.close();
		releaseFactory?.();

		await closePromise;
		await expect(connectPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		expect(lifecycle.state).toBe("closed");
	});

	it("allows a terminal closed lifecycle to connect again with a fresh transport", async () => {
		const factory = freshPairFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const lifecycle = new MCPServerLifecycle(
			{ ...STDIO_CONFIG, id: "docs" },
			{ transportFactory: factory.transportFactory },
		);
		serverCleanups.push(async () => lifecycle.forceClose().catch(() => undefined));

		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");
		expect(factory.serverCount()).toBe(1);

		await lifecycle.close();
		expect(lifecycle.state).toBe("closed");

		// A server that reached terminal closed reconnects on an explicit connect
		// with a fresh transport instead of staying stuck closed.
		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");
		expect(factory.serverCount()).toBe(2);
		const tools = await lifecycle.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);
		await lifecycle.close();
	});

	it("becomes unavailable when the transport start fails and never retains the raw error", async () => {
		const secret = "remote-secret-token-abc123";
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: async () => new FailingTransport(new Error(`process failed with ${secret}`)),
		});
		let thrown: unknown;
		try {
			await lifecycle.connect();
			expect.unreachable("expected connect to fail");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(MCPError);
		const mcpError = thrown as MCPError;
		expect(mcpError.kind).toBe("connect_failed");
		expect(mcpError.serverId).toBe("docs");
		expect(mcpError.code).toBe("capability_mcp_connect_failed");
		// the raw remote error must not be retained on the thrown MCPError
		expect(JSON.stringify(mcpError)).not.toContain(secret);
		expect(inspect(mcpError, { showHidden: true, depth: 5 })).not.toContain(secret);
		expect(lifecycle.state).toBe("unavailable");
		expect(lifecycle.getStatus().lastError).toMatchObject({
			kind: "connect_failed",
			code: "capability_mcp_connect_failed",
		});
	});

	it("classifies authentication failures as auth_required without leaking details", async () => {
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: async () => new FailingTransport(new UnauthorizedError("please authenticate with secret-flow")),
		});
		await expect(lifecycle.connect()).rejects.toMatchObject({
			kind: "auth_required",
			code: "capability_mcp_auth_required",
		});
		expect(lifecycle.state).toBe("unavailable");
		const serialized = JSON.stringify(lifecycle.getStatus());
		expect(serialized).not.toContain("secret-flow");
	});

	it("marks the server degraded and maps to capability unavailable when listTools fails", async () => {
		const setup = createMockServerFactory({ listToolsError: new Error("server secret list failure") });
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");

		await expect(lifecycle.listTools()).rejects.toMatchObject({
			kind: "unavailable",
			code: "capability_mcp_unavailable",
		});
		expect(lifecycle.state).toBe("degraded");
		const status = lifecycle.getStatus();
		expect(status).toMatchObject({ state: "degraded", availability: "degraded" });
		expect(status.lastError).toMatchObject({ kind: "unavailable", code: "capability_mcp_unavailable" });
		const serialized = JSON.stringify(status);
		expect(serialized).not.toContain("server secret list failure");
		expect(serialized).not.toContain("list failure");
	});

	it("returns successful and error-flagged call results", async () => {
		const setup = createMockServerFactory({
			tools: [
				{ name: "ok", inputSchema: { type: "object", properties: {} } },
				{ name: "boom", inputSchema: { type: "object", properties: {} } },
			],
			callHandler: (name) =>
				name === "boom"
					? { content: [{ type: "text", text: "kaboom" }], isError: true }
					: { content: [{ type: "text", text: "all good" }], structuredContent: { ok: 1 } },
		});
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();

		const ok = await lifecycle.callTool("ok", {});
		expect(ok.isError).toBe(false);
		expect(ok.content).toContainEqual({ type: "text", text: "all good" });
		expect(ok.structuredContent).toEqual({ ok: 1 });

		const boom = await lifecycle.callTool("boom", {});
		expect(boom.isError).toBe(true);
		expect(boom.serverId).toBe("docs");
		expect(boom.toolName).toBe("boom");
		// a server error result does not degrade the connection
		expect(lifecycle.state).toBe("ready");
	});

	it("marks the server degraded when a call fails at the transport level and refuses later calls", async () => {
		const setup = createMockServerFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();
		await setup.server.close();
		await flush();
		expect(lifecycle.state).toBe("degraded");

		await expect(lifecycle.callTool("list", {})).rejects.toMatchObject({
			kind: "unavailable",
			code: "capability_mcp_unavailable",
		});
	});

	it("rejects a call with AbortError on cancellation without degrading the server", async () => {
		const setup = createMockServerFactory({ holdCalls: true });
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();

		const controller = new AbortController();
		const callPromise = lifecycle.callTool("slow", {}, controller.signal);
		await waitUntil(() => setup.receivedCalls.length === 1);

		controller.abort();
		await expect(callPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(lifecycle.state).toBe("ready");

		setup.releaseCallGate();
	});

	it("force-closes an in-flight call and ends in the closed state", async () => {
		const setup = createMockServerFactory({ holdCalls: true });
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();

		const callPromise = lifecycle.callTool("slow", {});
		await waitUntil(() => setup.receivedCalls.length === 1);

		const forceClosePromise = lifecycle.forceClose();
		await expect(callPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		await forceClosePromise;
		expect(lifecycle.state).toBe("closed");
		expect(lifecycle.getStatus().availability).toBe("unavailable");

		await expect(lifecycle.callTool("slow", {})).rejects.toMatchObject({
			code: "capability_mcp_unavailable",
		});
		setup.releaseCallGate();
	});

	it("becomes degraded when the transport drops unexpectedly from the server side", async () => {
		const setup = createMockServerFactory({ tools: [{ name: "list", inputSchema: { type: "object" } }] });
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();
		expect(lifecycle.state).toBe("ready");

		await setup.server.close();
		await waitUntil(() => lifecycle.state === "degraded");
		expect(lifecycle.getStatus().availability).toBe("degraded");
		expect(lifecycle.getStatus().lastError).toMatchObject({
			kind: "unavailable",
			code: "capability_mcp_unavailable",
		});
	});

	it("reconnects explicitly when connect is called again after degradation", async () => {
		const setup = createMockServerFactory({ tools: [{ name: "list", inputSchema: { type: "object" } }] });
		const lifecycle = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: setup.transportFactory,
		});
		await lifecycle.connect();
		await setup.server.close();
		await waitUntil(() => lifecycle.state === "degraded");

		const second = createMockServerFactory({ tools: [{ name: "list", inputSchema: { type: "object" } }] });
		const lifecycle2 = new MCPServerLifecycle({ ...STDIO_CONFIG, id: "docs" }, {
			transportFactory: second.transportFactory,
		});
		await lifecycle2.connect();
		expect(lifecycle2.state).toBe("ready");
		await lifecycle2.close();
	});
});

describe.each(["stdio", "streamable-http"] as const)(
	"MCP lifecycle contract: %s transport via injected in-memory transport",
	(transport) => {
		it("connects, lists tools, calls (success and error), degrades, and closes", async () => {
			const setup = createMockServerFactory({
				tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
				callHandler: (name) =>
					name === "boom"
						? { content: [{ type: "text", text: "boom" }], isError: true }
						: { content: [{ type: "text", text: `ok:${name}` }] },
			});
			const manager = managerWith([configFor(transport)], {
				selected: ["docs"],
				transportFactory: setup.transportFactory,
			});

			expect(manager.getStatus("docs")).toMatchObject({ state: "configured" });
			await manager.connect("docs");
			expect(manager.getStatus("docs")).toMatchObject({ state: "ready", availability: "available" });

			const tools = await manager.listTools("docs");
			expect(tools.map((tool) => tool.name)).toEqual(["list"]);
			expect(manager.getStatus("docs")?.toolCount).toBe(1);

			const ok = await manager.callTool("docs", "list", {});
			expect(ok.content).toContainEqual({ type: "text", text: "ok:list" });
			const boom = await manager.callTool("docs", "boom", {});
			expect(boom.isError).toBe(true);
			expect(manager.getStatus("docs")?.state).toBe("ready");

			// a dropped transport degrades the server for this transport too
			await setup.server.close();
			await waitUntil(() => manager.getStatus("docs")?.state === "degraded");
			expect(manager.getStatus("docs")).toMatchObject({ availability: "degraded" });

			await manager.closeAll();
			expect(manager.getStatus("docs")).toMatchObject({ state: "closed" });
		});

		it("classifies connect failures and maps listTools failure to capability unavailable", async () => {
			const failing = new MCPLifecycleManager({
				selectedServerIds: new Set(["docs"]),
				transportFactory: async () => new FailingTransport(new Error("launch failed")),
			});
			failing.registerServers([configFor(transport)]);
			serverCleanups.push(async () => failing.closeAll().catch(() => undefined));
			await expect(failing.connect("docs")).rejects.toMatchObject({
				kind: "connect_failed",
				code: "capability_mcp_connect_failed",
			});
			expect(failing.getStatus("docs")).toMatchObject({ state: "unavailable" });

			const badList = createMockServerFactory({ listToolsError: new Error("list failed") });
			const listManager = managerWith([configFor(transport)], {
				selected: ["docs"],
				transportFactory: badList.transportFactory,
			});
			await listManager.connect("docs");
			await expect(listManager.listTools("docs")).rejects.toMatchObject({
				kind: "unavailable",
				code: "capability_mcp_unavailable",
			});
			expect(listManager.getStatus("docs")).toMatchObject({ state: "degraded", availability: "degraded" });
			expect(listManager.getStatus("docs")?.lastError).toMatchObject({
				kind: "unavailable",
				code: "capability_mcp_unavailable",
			});
		});
	},
);

class FailingTransport implements Transport {
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

	async send(): Promise<void> {}

	async close(): Promise<void> {}
}

describe("selected binding gates", () => {
	it("refuses to connect, list, or call a server the binding did not select", async () => {
		const selected = createMockServerFactory();
		const unselected = createMockServerFactory();
		const manager = managerWith(
			[
				{ id: "selected", transport: "stdio", command: "node" },
				{ id: "unselected", transport: "stdio", command: "node" },
			],
			{ selected: ["selected"], transportFactory: selected.transportFactory },
		);

		await expect(manager.connect("unselected")).rejects.toMatchObject({
			kind: "not_selected",
			serverId: "unselected",
			code: "capability_denied",
		});
		await expect(manager.listTools("unselected")).rejects.toMatchObject({ kind: "not_selected" });
		await expect(manager.callTool("unselected", "x", {})).rejects.toMatchObject({ kind: "not_selected" });

		// the unselected server stays configured and is never connected
		expect(manager.getStatus("unselected")).toMatchObject({ state: "configured" });
		expect(unselected.receivedCalls).toHaveLength(0);
		expect(manager.isSelected("selected")).toBe(true);
	});

	it("copies the selected server id set so caller mutation cannot change selection", async () => {
		const selected = new Set(["docs"]);
		const manager = new MCPLifecycleManager({ selectedServerIds: selected });
		selected.add("sneaky");
		expect(manager.getSelectedServerIds().has("sneaky")).toBe(false);
		expect(manager.isSelected("sneaky")).toBe(false);
		expect(manager.isSelected("docs")).toBe(true);

		const setterSelected = new Set(["docs"]);
		manager.setSelectedServerIds(setterSelected);
		setterSelected.add("sneaky2");
		expect(manager.isSelected("sneaky2")).toBe(false);
		expect(manager.isSelected("docs")).toBe(true);

		// a JS/cast caller that mutates the returned ReadonlySet snapshot must not
		// be able to bypass the selected-binding gate
		const snapshot = manager.getSelectedServerIds() as Set<string>;
		snapshot.add("sneaky3");
		snapshot.delete("docs");
		expect(manager.isSelected("sneaky3")).toBe(false);
		expect(manager.isSelected("docs")).toBe(true);
		expect(manager.getSelectedServerIds().has("docs")).toBe(true);
	});

	it("connects and calls a selected server", async () => {
		const setup = createMockServerFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
			callHandler: () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const manager = managerWith([{ id: "docs", transport: "stdio", command: "node" }], {
			selected: ["docs"],
			transportFactory: setup.transportFactory,
		});
		await manager.connect("docs");
		const tools = await manager.listTools("docs");
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);
		const result = await manager.callTool("docs", "list", { q: 1 });
		expect(result.content).toContainEqual({ type: "text", text: "ok" });
		expect(manager.getStatus("docs")).toMatchObject({ state: "ready" });
	});

	it("exposes redacted config views through the manager", () => {
		const manager = new MCPLifecycleManager({ selectedServerIds: new Set(["tracker", "docs"]) });
		manager.registerServers([
			{
				id: "tracker",
				transport: "streamable-http",
				url: "https://user:pass@host.example/mcp?token=sk-query",
				headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
			},
			{
				id: "docs",
				transport: "stdio",
				command: "node",
				args: ["--token", "sk-secret"],
				env: ["DOCS_TOKEN"],
			},
		]);
		expect(manager.getConfigView("tracker")).toEqual({
			id: "tracker",
			transport: "streamable-http",
			url: "https://host.example/mcp",
			headerNames: ["Authorization"],
			envNames: ["ISSUE_TRACKER_TOKEN"],
		});
		expect(manager.getConfigView("docs")).toEqual({
			id: "docs",
			transport: "stdio",
			command: "node",
			envNames: ["DOCS_TOKEN"],
		});
		const serialized = JSON.stringify({ tracker: manager.getConfigView("tracker"), docs: manager.getConfigView("docs") });
		expect(serialized).not.toContain("sk-query");
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("--token");
	});

	it("rejects duplicate server ids at registration", () => {
		const manager = new MCPLifecycleManager({ selectedServerIds: new Set(["docs"]) });
		expect(() =>
			manager.registerServers([
				{ id: "docs", transport: "stdio", command: "node" },
				{ id: "docs", transport: "stdio", command: "node" },
			]),
		).toThrowError(MCPError);
		expect(() =>
			manager.registerServers([
				{ id: "docs", transport: "stdio", command: "node" },
				{ id: "docs", transport: "stdio", command: "node" },
			]),
		).toThrowError(/Duplicate MCP server id/);
	});

	it("refuses to connect an unknown server", async () => {
		const manager = new MCPLifecycleManager({ selectedServerIds: new Set(["docs"]) });
		await expect(manager.connect("ghost")).rejects.toMatchObject({
			kind: "invalid_config",
			code: "capability_denied",
		});
	});

	it("treats an invalid server id as a configuration failure at connect time", async () => {
		const manager = new MCPLifecycleManager({
			selectedServerIds: new Set(["a__b"]),
			transportFactory: async () => new FailingTransport(new Error("should not start")),
		});
		manager.registerServers([{ id: "a__b", transport: "stdio", command: "node" }]);
		await expect(manager.connect("a__b")).rejects.toMatchObject({
			kind: "invalid_config",
			code: "capability_denied",
		});
		expect(manager.getStatus("a__b")).toMatchObject({ state: "unavailable" });
	});

	it("closeAll force-closes every registered server", async () => {
		const first = createMockServerFactory();
		const manager = new MCPLifecycleManager({
			selectedServerIds: new Set(["a", "b"]),
			transportFactory: first.transportFactory,
		});
		manager.registerServers([
			{ id: "a", transport: "stdio", command: "node" },
			{ id: "b", transport: "stdio", command: "node" },
		]);
		serverCleanups.push(async () => manager.closeAll().catch(() => undefined));
		await manager.connect("a");
		expect(manager.getStatus("a")).toMatchObject({ state: "ready" });

		await manager.closeAll();
		expect(manager.getStatus("a")).toMatchObject({ state: "closed" });
		expect(manager.getStatus("b")).toMatchObject({ state: "closed" });
	});

	it("never connects a server just because it is registered", async () => {
		const setup = createMockServerFactory();
		const manager = managerWith([{ id: "docs", transport: "stdio", command: "node" }], {
			selected: ["docs"],
			transportFactory: setup.transportFactory,
		});
		expect(manager.getStatus("docs")).toMatchObject({ state: "configured" });
		await manager.closeAll();
	});
});

describe("deselection and selection updates", () => {
	it("closes a deselected ready server and reports closed while the kept server stays ready", async () => {
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{
				selected: ["keep", "drop"],
				transportFactory: multiServerFactory(["keep", "drop"], {
					tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
					callHandler: () => ({ content: [{ type: "text", text: "ok" }] }),
				}),
			},
		);
		await manager.connect("keep");
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready", availability: "available" });

		await manager.setSelectedServerIds(["keep"]);

		expect(manager.isSelected("drop")).toBe(false);
		expect(manager.getSelectedServerIds().has("keep")).toBe(true);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed", availability: "unavailable" });
		expect(manager.getStatus("keep")).toMatchObject({ state: "ready", availability: "available" });
		// the deselected server is gated out of every operation
		await expect(manager.connect("drop")).rejects.toMatchObject({
			kind: "not_selected",
			code: "capability_denied",
		});
		await expect(manager.listTools("drop")).rejects.toMatchObject({ kind: "not_selected" });
		await expect(manager.callTool("drop", "list", {})).rejects.toMatchObject({ kind: "not_selected" });
		// the kept server remains usable
		const result = await manager.callTool("keep", "list", {});
		expect(result.content).toContainEqual({ type: "text", text: "ok" });
		expect(manager.getStatus("keep")?.state).toBe("ready");
	});

	it("deselection while a connection is in flight closes the server and its late transport", async () => {
		const setup = createMockServerFactory();
		const gated = gateCloseFactory(setup.transportFactory);
		let releaseFactory: (() => void) | undefined;
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{
				selected: ["keep", "drop"],
				transportFactory: async (config) => {
					await factoryGate;
					return gated.transportFactory(config);
				},
			},
		);

		const connectPromise = manager.connect("drop");
		await waitUntil(() => manager.getStatus("drop")?.state === "connecting");

		const deselect = manager.setSelectedServerIds(["keep"]);
		releaseFactory?.();
		// the deselected server's connect resumes and creates a transport, which
		// the lifecycle must release instead of leaving the child/connection alive
		await waitUntil(() => gated.transportCount() >= 1);

		gated.releaseAll();
		await deselect;
		await expect(connectPromise).rejects.toMatchObject({ code: "capability_mcp_unavailable" });
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed" });
		expect(manager.getStatus("keep")).toMatchObject({ state: "configured" });
		expect(gated.closeCount()).toBe(1);
	});

	it("does not settle a deselection update until the removed server's transport is released", async () => {
		const setup = createMockServerFactory();
		const gated = gateCloseFactory(setup.transportFactory);
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{ selected: ["keep", "drop"], transportFactory: gated.transportFactory },
		);
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready" });

		let settled = false;
		const deselect = manager.setSelectedServerIds(["keep"]).then(() => {
			settled = true;
		});
		await waitUntil(() => gated.closeCount() >= 1);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closing" });
		expect(settled).toBe(false);

		gated.releaseAll();
		await deselect;
		expect(settled).toBe(true);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed" });
		expect(gated.closeCount()).toBe(1);
	});

	it("supersedes a deselection close when a newer update re-selects the server before the close runs", async () => {
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{
				selected: ["keep", "drop"],
				transportFactory: multiServerFactory(["keep", "drop"], {
					tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		);
		await manager.connect("keep");
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready" });

		const first = manager.setSelectedServerIds(["keep"]);
		const second = manager.setSelectedServerIds(["keep", "drop"]);
		await first;
		await second;

		expect(manager.isSelected("drop")).toBe(true);
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready" });
		// the re-selected server's connection is preserved and still usable
		const tools = await manager.listTools("drop");
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);
	});

	it("coalesces concurrent deselections of the same server into one close", async () => {
		const setup = createMockServerFactory();
		const gated = gateCloseFactory(setup.transportFactory);
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{ selected: ["keep", "drop"], transportFactory: gated.transportFactory },
		);
		await manager.connect("drop");

		// First deselection starts the close and holds it; re-selecting and then
		// re-deselecting while that close is still pending must coalesce onto the
		// same teardown rather than closing the transport twice.
		const first = manager.setSelectedServerIds(["keep"]);
		await waitUntil(() => gated.closeCount() >= 1);
		const reselect = manager.setSelectedServerIds(["keep", "drop"]);
		const second = manager.setSelectedServerIds(["keep"]);
		gated.releaseAll();

		await first;
		await reselect;
		await second;
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed" });
		expect(gated.closeCount()).toBe(1);
	});

	it("completes an already-invoked close when the server is re-selected mid-close and never reopens it", async () => {
		const setup = createMockServerFactory();
		const gated = gateCloseFactory(setup.transportFactory);
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{ selected: ["keep", "drop"], transportFactory: gated.transportFactory },
		);
		await manager.connect("drop");

		const first = manager.setSelectedServerIds(["keep"]);
		await waitUntil(() => gated.closeCount() >= 1);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closing" });

		// Re-select mid-close: the close is already invoked, so it completes and
		// the lifecycle stays closed; the manager never silently reopens it.
		const reselect = manager.setSelectedServerIds(["keep", "drop"]);
		gated.releaseAll();
		await first;
		await reselect;

		expect(manager.isSelected("drop")).toBe(true);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed" });
		expect(gated.closeCount()).toBe(1);
	});

	it("reconnects a deselected closed server with a fresh transport when it is selected again and explicitly connected", async () => {
		const setup = freshPairFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const gated = gateCloseFactory(setup.transportFactory);
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{ selected: ["keep", "drop"], transportFactory: gated.transportFactory },
		);
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready" });

		// Deselect: the close fully completes and the server reaches terminal closed.
		const deselect = manager.setSelectedServerIds(["keep"]);
		await waitUntil(() => gated.closeCount() >= 1);
		gated.releaseAll();
		await deselect;
		expect(manager.isSelected("drop")).toBe(false);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed", availability: "unavailable" });
		expect(gated.closeCount()).toBe(1);

		// Re-select and explicitly connect: a fresh transport backs the new
		// connection and the old transport is neither reused nor closed again.
		await manager.setSelectedServerIds(["keep", "drop"]);
		expect(manager.isSelected("drop")).toBe(true);
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready", availability: "available" });
		expect(gated.transportCount()).toBe(2);
		expect(gated.closeCount()).toBe(1);
		const tools = await manager.listTools("drop");
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);

		gated.releaseAll();
	});

	it("reconnects with a fresh transport after a close/reselect race completes the invoked close", async () => {
		const setup = freshPairFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const gated = gateCloseFactory(setup.transportFactory);
		const manager = managerWith(
			[
				{ id: "keep", transport: "stdio", command: "node" },
				{ id: "drop", transport: "stdio", command: "node" },
			],
			{ selected: ["keep", "drop"], transportFactory: gated.transportFactory },
		);
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready" });

		// Deselect begins the close; re-selecting mid-close completes it and leaves
		// the server closed (the manager never silently reopens it).
		const first = manager.setSelectedServerIds(["keep"]);
		await waitUntil(() => gated.closeCount() >= 1);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closing" });
		const reselect = manager.setSelectedServerIds(["keep", "drop"]);
		gated.releaseAll();
		await first;
		await reselect;
		expect(manager.isSelected("drop")).toBe(true);
		expect(manager.getStatus("drop")).toMatchObject({ state: "closed" });
		expect(gated.closeCount()).toBe(1);

		// An explicit connect after the closed server is selected again must build
		// a fresh transport instead of being stuck on the terminal closed state.
		await manager.connect("drop");
		expect(manager.getStatus("drop")).toMatchObject({ state: "ready", availability: "available" });
		expect(gated.transportCount()).toBe(2);
		expect(gated.closeCount()).toBe(1);
		const tools = await manager.listTools("drop");
		expect(tools.map((tool) => tool.name)).toEqual(["list"]);

		gated.releaseAll();
	});

	it("ignores a stale transport's late close notification so it cannot revive into the fresh connection", async () => {
		const inner = freshPairFactory({
			tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
		});
		const transports: ManualOnCloseTransport[] = [];
		const manager = managerWith([{ id: "docs", transport: "stdio", command: "node" }], {
			selected: ["docs"],
			transportFactory: async (config) => {
				const transport = new ManualOnCloseTransport(await inner.transportFactory(config));
				transports.push(transport);
				return transport;
			},
		});

		await manager.connect("docs");
		expect(manager.getStatus("docs")).toMatchObject({ state: "ready" });

		// Deselect: the close fully completes, but the transport's close
		// notification is delivered asynchronously (as with a delayed child-process
		// exit) so it has not fired by the time the lifecycle reaches terminal closed.
		await manager.setSelectedServerIds([]);
		expect(manager.getStatus("docs")).toMatchObject({ state: "closed" });

		// Re-select and reconnect: a fresh transport backs the new connection.
		await manager.setSelectedServerIds(["docs"]);
		await manager.connect("docs");
		expect(manager.getStatus("docs")).toMatchObject({ state: "ready", availability: "available" });
		expect(transports).toHaveLength(2);

		// The old transport's late close must not degrade the fresh connection.
		transports[0].fireClose();
		await flush();
		expect(manager.getStatus("docs")).toMatchObject({ state: "ready", availability: "available" });
	});
});
