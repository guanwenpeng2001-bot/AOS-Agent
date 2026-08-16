/**
 * Task F: MCP session integration tests.
 *
 * Focused fake-provider coverage for the AgentSession MCP surface: OAuth
 * transport wiring with the exactly-one refresh/retry contract, credential
 * namespace isolation from ModelRuntime provider enumeration, explicit-only
 * content list/read/attach, untrusted attach provenance in Context Engine
 * snapshots, policy/revision/parent denial, cancellation, and no auto side
 * effects. No real server, browser, token, credential, or network is ever
 * contacted: stdio servers run over in-memory linked transports and OAuth runs
 * against a fake HTTP environment with an injected fetch.
 */

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
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { mcpResourceId, mcpPromptId } from "../src/core/mcp-content-types.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport";
import {
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types";
import type { AuthEvent, AuthInteraction, CredentialStore } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CapabilityError, CapabilityRegistry } from "../src/core/capability-registry.ts";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import { assertSnapshotMetadataOnly } from "../src/core/context-engine.ts";
import { PolicyError } from "../src/core/execution-policy.ts";
import { MCPServerLifecycle } from "../src/core/mcp-lifecycle.ts";
import type { MCPEnvResolver, MCPServerConfig, MCPTransportFactoryOptions } from "../src/core/mcp-types.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager, type Settings } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const SERVER_URL = "https://mcp.invalid/mcp";
const AS_URL = "https://as.invalid/";
const REDIRECT_URL = "http://127.0.0.1:8765/mcp/callback";

const DEFAULT_PRM = {
	resource: "https://mcp.invalid/",
	authorization_servers: [AS_URL],
	scopes_supported: ["mcp"],
};

const DEFAULT_AS_METADATA = {
	issuer: AS_URL,
	authorization_endpoint: "https://as.invalid/authorize",
	token_endpoint: "https://as.invalid/token",
	registration_endpoint: "https://as.invalid/register",
	revocation_endpoint: "https://as.invalid/revoke",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	token_endpoint_auth_methods_supported: ["none"],
	code_challenge_methods_supported: ["S256"],
};

interface TokenResponse {
	status: number;
	body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function defaultTokenHandler(params: URLSearchParams): TokenResponse {
	const grant = params.get("grant_type");
	if (grant === "authorization_code") {
		return {
			status: 200,
			body: {
				access_token: "at-1",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "rt-1",
				scope: "mcp",
			},
		};
	}
	if (grant === "refresh_token") {
		return {
			status: 200,
			body: {
				access_token: "at-2",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "rt-2",
				scope: "mcp",
			},
		};
	}
	return { status: 400, body: { error: "unsupported_grant_type" } };
}

/**
 * Fake OAuth environment: protected resource metadata, authorization server
 * metadata (with a revocation endpoint), dynamic registration, token
 * endpoint, revocation endpoint, and a JSON-RPC MCP endpoint. Every request is
 * recorded for assertions; nothing leaves the test.
 */
class FakeAuthServer {
	prm: Record<string, unknown> | undefined = DEFAULT_PRM;
	asMetadata: Record<string, unknown> | undefined = DEFAULT_AS_METADATA;
	registrationStatus = 201;
	registrationBody: unknown = {
		client_id: "dcr-client-1",
		token_endpoint_auth_method: "none",
		redirect_uris: [REDIRECT_URL],
		grant_types: ["authorization_code"],
		response_types: ["code"],
	};
	tokenHandler: (params: URLSearchParams) => TokenResponse | Promise<TokenResponse> = defaultTokenHandler;
	/** Number of initial MCP POSTs answered with 401. */
	mcp401Count = 0;
	/** Per-method MCP JSON-RPC result dispatch. */
	mcpHandler: (method: string, params: unknown) => unknown = (method) => {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fake-mcp", version: "0.0.0" },
				};
			case "tools/list":
				return { tools: [] };
			default:
				return {};
		}
	};

	tokenRequests: Array<{ grant: string | null; params: URLSearchParams; headers: Headers }> = [];
	registrationRequests: Array<{ body: string; headers: Headers }> = [];
	revokeRequests: Array<{ body: string; headers: Headers }> = [];
	mcpPosts: Array<{ headers: Headers; body: string }> = [];
	requests = 0;

	fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		this.requests++;
		const target = new URL(String(url));
		const rawBody = init?.body;
		const body =
			typeof rawBody === "string"
				? rawBody
				: rawBody instanceof URLSearchParams
					? rawBody.toString()
					: undefined;
		const headers = new Headers(init?.headers);

		if (target.pathname.endsWith("/oauth-protected-resource/mcp")) {
			return jsonResponse(404, {});
		}
		if (target.pathname.endsWith("/oauth-protected-resource")) {
			if (this.prm === undefined) {
				return jsonResponse(404, {});
			}
			return jsonResponse(200, this.prm);
		}
		if (target.pathname.endsWith("/oauth-authorization-server")) {
			if (this.asMetadata === undefined) {
				return jsonResponse(404, {});
			}
			return jsonResponse(200, this.asMetadata);
		}
		if (target.pathname.endsWith("/openid-configuration")) {
			return jsonResponse(404, {});
		}
		if (target.pathname.endsWith("/register")) {
			this.registrationRequests.push({ body: body ?? "", headers });
			return jsonResponse(this.registrationStatus, this.registrationBody);
		}
		if (target.pathname.endsWith("/token")) {
			const params = new URLSearchParams(body ?? "");
			this.tokenRequests.push({ grant: params.get("grant_type"), params, headers });
			const result = await this.tokenHandler(params);
			return jsonResponse(result.status, result.body);
		}
		if (target.pathname.endsWith("/revoke")) {
			this.revokeRequests.push({ body: body ?? "", headers });
			return jsonResponse(200, {});
		}
		// MCP endpoint.
		this.mcpPosts.push({ headers, body: body ?? "" });
		if (this.mcpPosts.length <= this.mcp401Count) {
			return jsonResponse(401, {}, { "www-authenticate": 'Bearer realm="mcp"' });
		}
		let message: JSONRPCMessage | undefined;
		try {
			message = JSON.parse(body ?? "{}") as JSONRPCMessage;
		} catch {
			// Notifications and non-JSON payloads answer with an empty result.
		}
		const method = message !== undefined && "method" in message ? String(message.method) : "";
		const id = message !== undefined && "id" in message ? message.id : undefined;
		const result = this.mcpHandler(method, "params" in (message ?? {}) ? (message as { params?: unknown }).params : undefined);
		return jsonResponse(200, id === undefined ? { jsonrpc: "2.0", result } : { jsonrpc: "2.0", id, result });
	};
}

function makeInteraction(controller?: AbortController): AuthInteraction & { events: AuthEvent[] } {
	const events: AuthEvent[] = [];
	return {
		signal: controller?.signal,
		prompt: async () => "ok",
		notify: (event: AuthEvent) => {
			events.push(event);
		},
		events,
	};
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function authorizationUrlFromInteraction(interaction: { events: AuthEvent[] }): URL {
	const event = interaction.events.find((entry) => entry.type === "auth_url");
	if (event === undefined || event.type !== "auth_url") {
		throw new Error("no auth_url event captured");
	}
	return new URL(event.url);
}

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `aos-mcp-session-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { dir, agentDir };
}

function mcpSettings(server: Record<string, unknown>): Partial<Settings> {
	return { mcp: { servers: { docs: server } } };
}

/** Capabilities profile allowing the given MCP kinds for server "docs". */
function allowProfile(kinds: ReadonlyArray<string>): Partial<Settings> {
	return {
		capabilities: {
			defaultProfile: "default",
			profiles: {
				default: { rules: kinds.map((kind) => ({ selector: { kind }, action: "allow" })) },
			},
		},
	};
}

const ALLOWED_KINDS = ["mcp_server", "mcp_tool", "mcp_resource", "mcp_resource_template", "mcp_prompt"];

function httpServerSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		transport: "streamable-http",
		url: SERVER_URL,
		oauth: { redirectUrl: REDIRECT_URL },
		...overrides,
	};
}

function httpServerUrl(config: MCPServerConfig): string {
	if (config.transport !== "streamable-http") {
		throw new Error("expected a streamable-http MCP config");
	}
	return config.url;
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

const sessions: AgentSession[] = [];
const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		session.dispose();
		await session.waitForDispose().catch(() => undefined);
	}
	await Promise.all(
		serverCleanups
			.splice(0)
			.map((cleanup) => cleanup().catch(() => undefined)),
	);
});

/**
 * Build a controlled AgentSession with a real model/auth runtime and an
 * injectable MCP transport factory, so preflight and Context Engine boundaries
 * run for real while the provider stream and MCP servers are fake.
 */
async function createControlledSession(opts: {
	settingsManager: SettingsManager;
	mcpTransportFactory?: (
		config: MCPServerConfig,
		env: MCPEnvResolver,
		options?: MCPTransportFactoryOptions,
	) => Transport | Promise<Transport>;
	mcpAuthFetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
	onStreamCall?: () => void;
	dir?: string;
	agentDir?: string;
}): Promise<{
	session: AgentSession;
	dir: string;
	agentDir: string;
	authStorage: CredentialStore;
	modelRuntime: ModelRuntime;
}> {
	const temp = opts.dir === undefined ? tmpDir("controlled") : undefined;
	const dir = opts.dir ?? temp!.dir;
	const agentDir = opts.agentDir ?? temp!.agentDir;
	mkdirSync(agentDir, { recursive: true });
	const sessionManager = SessionManager.inMemory(dir);
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, dir);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			opts.onStreamCall?.();
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
		resourceLoader: createEmptyResourceLoader(),
		mcpTransportFactory: opts.mcpTransportFactory,
		mcpAuthFetch: opts.mcpAuthFetch as never,
		capabilityRegistry: new CapabilityRegistry(await CapabilityPublicIdentity.load(agentDir)),
	});
	sessions.push(session);
	return { session, dir, agentDir, authStorage, modelRuntime: getModelRuntime(modelRegistry) };
}

function createEmptyResourceLoader(): ResourceLoader {
	return createTestResourceLoader();
}

async function runSessionAuthFlow(
	session: AgentSession,
	serverId = "docs",
	code = "auth-code-1",
): Promise<void> {
	const interaction = makeInteraction();
	const promise = session.startMcpAuth(serverId, interaction);
	await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
	const state = authorizationUrlFromInteraction(interaction).searchParams.get("state");
	if (state === null) {
		throw new Error("authorization URL carries no state");
	}
	await session.completeMcpAuth(serverId, code, { state });
	const result = await promise;
	expect(result.outcome).toBe("authorized");
}

// ---------------------------------------------------------------------------
// Part A: lifecycle-level OAuth hooks (exactly-one refresh/retry contract)
// ---------------------------------------------------------------------------

function createAuthRejectingTransportFactory(failures: number): {
	transportFactory: (config: MCPServerConfig) => Transport;
	sends: () => number;
	cleanup: () => Promise<void>;
} {
	let sends = 0;
	let remaining = failures;
	const cleanups: Array<() => Promise<void>> = [];
	const transportFactory = (): Transport => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
		server.connect(serverTransport).catch(() => undefined);
		cleanups.push(async () => {
			await server.close().catch(() => undefined);
			await clientTransport.close().catch(() => undefined);
		});
		const wrapper: Transport = {
			start: () => clientTransport.start(),
			close: () => clientTransport.close(),
			send: async (message: JSONRPCMessage, options?: TransportSendOptions) => {
				sends++;
				// The initialize handshake and initialized notification must succeed so
				// the connection becomes ready; only later requests exercise the auth
				// retry contract.
				const method = "method" in message ? String(message.method) : "";
				if (remaining > 0 && method !== "initialize" && method !== "notifications/initialized") {
					remaining--;
					throw new UnauthorizedError("fake 401");
				}
				return clientTransport.send(message, options);
			},
		};
		Object.defineProperty(wrapper, "onmessage", {
			get: () => clientTransport.onmessage,
			set: (value) => {
				clientTransport.onmessage = value;
			},
		});
		Object.defineProperty(wrapper, "onclose", {
			get: () => clientTransport.onclose,
			set: (value) => {
				clientTransport.onclose = value;
			},
		});
		Object.defineProperty(wrapper, "onerror", {
			get: () => clientTransport.onerror,
			set: (value) => {
				clientTransport.onerror = value;
			},
		});
		return wrapper;
	};
	return {
		transportFactory: transportFactory as unknown as (config: MCPServerConfig) => Transport,
		sends: () => sends,
		cleanup: async () => {
			await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
		},
	};
}

function httpConfig(): MCPServerConfig {
	return { id: "docs", transport: "streamable-http", url: SERVER_URL };
}

describe("MCP lifecycle OAuth hooks", () => {
	it("retries exactly once after exactly one refresh on UnauthorizedError", async () => {
		const fake = createAuthRejectingTransportFactory(1);
		let refreshes = 0;
		const lifecycle = new MCPServerLifecycle(httpConfig(), {
			transportFactory: fake.transportFactory,
			auth: {
				refresh: async () => {
					refreshes++;
					return "authorized";
				},
			},
		});
		await lifecycle.connect();
		const tools = await lifecycle.listTools();
		expect(tools).toEqual([]);
		expect(refreshes).toBe(1);
		expect(fake.sends()).toBe(4); // initialize + initialized + listTools + one retry
		expect(lifecycle.state).toBe("ready");
		await lifecycle.close();
		await fake.cleanup();
	});

	it("classifies persistent UnauthorizedError as auth_required without degrading", async () => {
		const fake = createAuthRejectingTransportFactory(Number.POSITIVE_INFINITY);
		let refreshes = 0;
		const lifecycle = new MCPServerLifecycle(httpConfig(), {
			transportFactory: fake.transportFactory,
			auth: {
				refresh: async () => {
					refreshes++;
					return "authorized";
				},
			},
		});
		await lifecycle.connect();
		await expect(lifecycle.listTools()).rejects.toMatchObject({
			kind: "auth_required",
			serverId: "docs",
			code: "capability_mcp_auth_required",
		});
		// Exactly one refresh and exactly one retry happened.
		expect(refreshes).toBe(1);
		expect(fake.sends()).toBe(4); // initialize + initialized + listTools + one retry
		// The fixed message never embeds remote text.
		await expect(lifecycle.listTools()).rejects.toThrow('MCP server "docs" requires authentication');
		// Auth failure is not a transport failure: the connection stays ready.
		expect(lifecycle.state).toBe("ready");
		expect(lifecycle.getStatus().lastError?.kind).toBe("auth_required");
		await lifecycle.close();
		await fake.cleanup();
	});

	it("does not retry when refresh cannot produce a token", async () => {
		const fake = createAuthRejectingTransportFactory(Number.POSITIVE_INFINITY);
		let refreshes = 0;
		const lifecycle = new MCPServerLifecycle(httpConfig(), {
			transportFactory: fake.transportFactory,
			auth: {
				refresh: async () => {
					refreshes++;
					return "interaction_required";
				},
			},
		});
		await lifecycle.connect();
		await expect(lifecycle.listTools()).rejects.toMatchObject({ kind: "auth_required" });
		expect(refreshes).toBe(1);
		expect(fake.sends()).toBe(3); // initialize + initialized + one listTools attempt, no retry
		await lifecycle.close();
		await fake.cleanup();
	});
});

// ---------------------------------------------------------------------------
// Part B: AgentSession OAuth surface
// ---------------------------------------------------------------------------

describe("AgentSession MCP OAuth surface", () => {
	it("runs the interactive flow through the public methods and persists into the MCP namespace", async () => {
		const { dir, agentDir } = tmpDir("auth-flow");
		const fake = new FakeAuthServer();
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const { session, authStorage } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});

			const before = await session.getMcpAuthStatus("docs");
			expect(before.authSupported).toBe(true);
			expect(before.auth.state).toBe("unauthenticated");
			expect(before.credential.hasCredential).toBe(false);

			await runSessionAuthFlow(session);

			const after = await session.getMcpAuthStatus("docs");
			expect(after.auth.state).toBe("authenticated");
			expect(after.credential.status).toBe("authenticated");
			expect(after.credential.hasCredential).toBe(true);
			// The record lives in the MCP namespace key, scoped per source+server.
			const stored = await authStorage.read("mcp:global:docs");
			expect(stored).toBeDefined();
			expect((stored as { access: string }).access).toBe("at-1");
			expect(fake.tokenRequests.filter((entry) => entry.grant === "authorization_code")).toHaveLength(1);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hydrates the namespace record into a fresh session", async () => {
		const { dir, agentDir } = tmpDir("auth-hydrate");
		const fake = new FakeAuthServer();
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const first = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			await runSessionAuthFlow(first.session);
			first.session.dispose();
			await first.session.waitForDispose();

			// A fresh session on the same agent dir hydrates the stored binding.
			const second = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			const status = await second.session.getMcpAuthStatus("docs");
			expect(status.credential.hasCredential).toBe(true);
			expect(status.credential.status).toBe("authenticated");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps MCP credentials out of model provider enumeration", async () => {
		const { dir, agentDir } = tmpDir("auth-enum");
		const fake = new FakeAuthServer();
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const { session, modelRuntime, authStorage } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			await runSessionAuthFlow(session);

			// The credential is visible through the raw store...
			const entries = await authStorage.list();
			expect(entries.some((entry) => entry.providerId === "mcp:global:docs")).toBe(true);
			// ...but never as a model provider.
			expect(modelRuntime.getProviderAuthStatus("docs")).toEqual({ configured: false });
			expect(modelRuntime.getProviderAuthStatus("mcp:global:docs")).toEqual({ configured: false });
			expect(modelRuntime.getAvailableSnapshot().some((entry) => entry.provider.includes("mcp:"))).toBe(false);
			expect(modelRuntime.getModels().some((entry) => entry.provider.includes("mcp:"))).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("isolates credentials per server and logs out with local cleanup and best-effort revoke", async () => {
		const { dir, agentDir } = tmpDir("auth-isolation");
		const fake = new FakeAuthServer();
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			mcp: {
				servers: {
					docs: httpServerSettings(),
					git: httpServerSettings(),
				},
			},
		});
		try {
			const { session, authStorage } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			await runSessionAuthFlow(session, "docs");

			// The other server's slot is untouched.
			const git = await session.getMcpAuthStatus("git");
			expect(git.credential.hasCredential).toBe(false);
			expect((await authStorage.read("mcp:global:git"))).toBeUndefined();

			// Logout revokes best-effort and clears the local record.
			await session.logoutMcpAuth("docs");
			expect(fake.revokeRequests).toHaveLength(1);
			expect(fake.revokeRequests[0]?.body).toContain("rt-1");
			expect(await authStorage.read("mcp:global:docs")).toBeUndefined();
			const after = await session.getMcpAuthStatus("docs");
			expect(after.credential.hasCredential).toBe(false);
			expect(after.auth.state).toBe("unauthenticated");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("performs exactly one refresh and one retry for connect after a 401", async () => {
		const { dir, agentDir } = tmpDir("auth-connect-retry");
		const fake = new FakeAuthServer();
		fake.mcp401Count = 1;
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			await runSessionAuthFlow(session);
			await session.whenCapabilitiesReady();

			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			expect(fake.tokenRequests.filter((entry) => entry.grant === "refresh_token")).toHaveLength(1);
			expect(fake.mcpPosts.length).toBeGreaterThanOrEqual(2);
			expect(fake.mcpPosts[1]?.headers.get("authorization")).toBe("Bearer at-2");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps unsatisfiable connect auth to a fixed auth_required error", async () => {
		const { dir, agentDir } = tmpDir("auth-required");
		const fake = new FakeAuthServer();
		fake.mcp401Count = 1;
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			// No tokens and no flow: discovery must fail closed with auth_required.
			await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
				code: "capability_mcp_auth_required",
			});
			expect(session.getMcpConnectionStatus("docs")?.lastError?.kind).toBe("auth_required");
			expect(fake.tokenRequests).toHaveLength(0);
			// The recorded error message is the fixed template, never a URL or token.
			const lastError = session.getMcpConnectionStatus("docs")?.lastError;
			expect(lastError?.message).not.toContain("mcp.invalid");
			expect(lastError?.message).toContain("requires authentication");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never starts auth or connects without explicit requests", async () => {
		const { dir, agentDir } = tmpDir("auth-lazy");
		const fake = new FakeAuthServer();
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(ALLOWED_KINDS),
			...mcpSettings(httpServerSettings()),
		});
		try {
			const { session, authStorage } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: (config, _env, options) =>
					new StreamableHTTPClientTransport(new URL(httpServerUrl(config)), {
						authProvider: options?.authProvider,
						fetch: fake.fetch,
					}),
				mcpAuthFetch: fake.fetch,
			});
			// Construction and status inspection produce zero network traffic.
			expect(fake.requests).toBe(0);
			await session.getMcpAuthStatus("docs");
			expect(fake.requests).toBe(0);
			expect(session.getMcpConnectionStatus("docs")?.state).toBe("configured");
			expect((await authStorage.list()).some((entry) => entry.providerId.startsWith("mcp:"))).toBe(false);
			expect(fake.tokenRequests).toHaveLength(0);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Part C: explicit MCP content surface (list / read / attach)
// ---------------------------------------------------------------------------

interface ContentResource {
	uri: string;
	name: string;
	text: string;
	mimeType?: string;
}

interface ContentPrompt {
	name: string;
	description?: string;
	messages: ReadonlyArray<{ role: "user" | "assistant"; content: ReadonlyArray<{ type: "text"; text: string }> }>;
}

function createInMemoryContentServer(opts: {
	resources?: ContentResource[];
	prompts?: ContentPrompt[];
}): {
	transportFactory: (config: MCPServerConfig) => Promise<Transport>;
	reads: string[];
	getPromptCalls: string[];
} {
	const reads: string[] = [];
	const getPromptCalls: string[] = [];
	const transportFactory = async (_config: MCPServerConfig): Promise<Transport> => {
		// Lifecycle policy rebinding may close and recreate the selected server;
		// every factory call therefore owns a fresh linked pair.
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = new Server(
			{ name: "content-server", version: "1.0.0" },
			{ capabilities: { tools: {}, resources: {}, prompts: {} } },
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
		server.setRequestHandler(ListResourcesRequestSchema, async () => ({
			resources:
				opts.resources?.map((resource) => ({
					uri: resource.uri,
					name: resource.name,
					...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
				})) ?? [],
		}));
		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			reads.push(request.params.uri);
			const resource = opts.resources?.find((entry) => entry.uri === request.params.uri);
			if (resource === undefined) {
				throw new Error("resource not found");
			}
			return {
				contents: [
					{
						uri: resource.uri,
						text: resource.text,
						...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
					},
				],
			};
		});
		server.setRequestHandler(ListPromptsRequestSchema, async () => ({
			prompts:
				opts.prompts?.map((prompt) => ({
					name: prompt.name,
					...(prompt.description === undefined ? {} : { description: prompt.description }),
				})) ?? [],
		}));
		server.setRequestHandler(GetPromptRequestSchema, async (request) => {
			getPromptCalls.push(request.params.name);
			const prompt = opts.prompts?.find((entry) => entry.name === request.params.name);
			if (prompt === undefined) {
				throw new Error("prompt not found");
			}
			return {
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				messages: prompt.messages.map((message) => ({
					role: message.role,
					content: message.content[0] ?? { type: "text", text: "" },
				})),
			};
		});
		server.connect(serverTransport).catch(() => undefined);
		serverCleanups.push(async () => {
			await server.close().catch(() => undefined);
			await clientTransport.close().catch(() => undefined);
		});
		return clientTransport;
	};
	return { transportFactory, reads, getPromptCalls };
}

const RESOURCE_A: ContentResource = { uri: "docs://guide", name: "Guide", text: "guide body" };
const RESOURCE_ID = mcpResourceId("docs", "docs://guide");
const PROMPT_ID = mcpPromptId("docs", "summarize");

const PROMPT_A: ContentPrompt = {
	name: "summarize",
	description: "Summarize",
	messages: [{ role: "user", content: [{ type: "text", text: "summarize body" }] }],
};

function stdioContentSettings(): Partial<Settings> {
	return {
		...allowProfile(ALLOWED_KINDS),
		mcp: { servers: { docs: { transport: "stdio", command: "node" } } },
	};
}

describe("AgentSession MCP content surface", () => {
	it("lists content, registers secret-free descriptors, and never auto-reads", async () => {
		const { dir, agentDir } = tmpDir("content-list");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A], prompts: [PROMPT_A] });
		const settingsManager = SettingsManager.inMemory(stdioContentSettings());
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();

			const resources = await session.listMcpResources("docs");
			expect(resources.items.map((item) => item.resourceId)).toEqual([mcpResourceId("docs", "docs://guide")]);
			await session.listMcpPrompts("docs");

			// Listing only registered descriptors; nothing was read.
			expect(mock.reads).toEqual([]);
			expect(mock.getPromptCalls).toEqual([]);

			const catalog = session.inspectCapabilityCatalog();
			const serverDescriptor = catalog.descriptors.find((entry) => entry.kind === "mcp_server");
			const resourceDescriptor = catalog.descriptors.find((entry) => entry.kind === "mcp_resource");
			const promptDescriptor = catalog.descriptors.find((entry) => entry.kind === "mcp_prompt");
			expect(serverDescriptor).toBeDefined();
			// Stable secret-free revision and digest local name.
			expect(resourceDescriptor?.revision).toMatch(/^rev:/);
			expect(resourceDescriptor?.id).toContain("mcp-content-");
			expect(resourceDescriptor?.mcpServerId).toBe("docs");
			// Content descriptors are parented to the mcp_server.
			expect(resourceDescriptor?.parentId).toBe(serverDescriptor?.id);
			expect(promptDescriptor?.parentId).toBe(serverDescriptor?.id);
			// The frozen binding selected them.
			const binding = session.getActiveCapabilityBinding();
			expect(binding?.descriptors.some((ref) => ref.id === resourceDescriptor?.id)).toBe(true);
			expect(binding?.descriptors.some((ref) => ref.id === promptDescriptor?.id)).toBe(true);
			// The tool allowlist is unaffected by content discovery.
			expect(binding?.toolAllowlist.some((name) => name.startsWith("mcp__"))).toBe(false);

			// The retained catalog is secret-free metadata only.
			const retained = session.getMcpContentCatalog("docs");
			expect(retained?.resources[0]?.name).toBe("Guide");
			expect(retained?.prompts[0]?.name).toBe("summarize");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads a listed resource and fetches a listed prompt only on explicit calls", async () => {
		const { dir, agentDir } = tmpDir("content-read");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A], prompts: [PROMPT_A] });
		const settingsManager = SettingsManager.inMemory(stdioContentSettings());
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await session.listMcpResources("docs");
			await session.listMcpPrompts("docs");

			const read = await session.readMcpResource("docs", RESOURCE_ID);
			expect(read.content.blocks).toContainEqual({ type: "text", text: "guide body" });
			expect(mock.reads).toEqual(["docs://guide"]);
			const prompt = await session.getMcpPrompt("docs", PROMPT_ID);
			expect(prompt.messages[0]?.content.blocks).toContainEqual({ type: "text", text: "summarize body" });
			expect(mock.getPromptCalls).toEqual(["summarize"]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies reads and attaches for content that was never listed", async () => {
		const { dir, agentDir } = tmpDir("content-never-listed");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A] });
		const settingsManager = SettingsManager.inMemory(stdioContentSettings());
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await expect(session.readMcpResource("docs", RESOURCE_ID)).rejects.toBeInstanceOf(CapabilityError);
			await expect(session.attachMcpResource("docs", RESOURCE_ID)).rejects.toBeInstanceOf(CapabilityError);
			expect(mock.reads).toEqual([]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies read and attach when the execution policy blocks the operation", async () => {
		const { dir, agentDir } = tmpDir("content-policy-deny");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A] });
		const settingsManager = SettingsManager.inMemory({
			...stdioContentSettings(),
			executionPolicy: {
				defaultProfile: "locked",
				profiles: {
					locked: {
						id: "locked",
						enforcement: "host",
						defaultAction: "allow",
						workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
						process: { action: "allow", inheritEnvironment: false, allowEnvironment: [], cwdScopes: ["workspace"], timeoutMs: 60_000 },
						network: { action: "allow", allowDestinations: [] },
						credentials: { action: "deny", allowNames: [] },
						approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
						rules: [
							{ resource: "mcp.content.read", action: "deny" },
							{ resource: "mcp.content.attach", action: "deny" },
						],
					},
				},
			},
		});
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await session.listMcpResources("docs");
			await expect(session.readMcpResource("docs", RESOURCE_ID)).rejects.toBeInstanceOf(PolicyError);
			await expect(session.attachMcpResource("docs", RESOURCE_ID)).rejects.toBeInstanceOf(PolicyError);
			expect(mock.reads).toEqual([]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies content operations when the parent mcp_server is not selected", async () => {
		const { dir, agentDir } = tmpDir("content-parent-deny");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A] });
		// Content kinds are allowed but the server itself is denied.
		const settingsManager = SettingsManager.inMemory({
			...allowProfile(["mcp_resource", "mcp_prompt", "mcp_tool"]),
			mcp: { servers: { docs: { transport: "stdio", command: "node" } } },
		});
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await expect(session.listMcpResources("docs")).rejects.toBeInstanceOf(PolicyError);
			expect(mock.reads).toEqual([]);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("attaches normalized bounded content as untrusted user context and clears it at the turn boundary", async () => {
		const { dir, agentDir } = tmpDir("content-attach");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A], prompts: [PROMPT_A] });
		const settingsManager = SettingsManager.inMemory(stdioContentSettings());
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await session.listMcpResources("docs");
			await session.listMcpPrompts("docs");

			const attached = await session.attachMcpResource("docs", RESOURCE_ID);
			expect(attached.contentLength).toBe("guide body".length);
			expect(attached.truncated).toBe(false);
			await session.attachMcpPrompt("docs", PROMPT_ID);
			expect(mock.reads).toEqual(["docs://guide"]);

			await session.prompt("hello");
			const snapshotId = session.getLastContextSnapshotId();
			expect(snapshotId).toBeDefined();
			const { snapshot } = await session.inspectContext({ snapshotId });
			const contentSources = snapshot.sources.filter((source) => source.kind === "mcp_content");
			expect(contentSources).toHaveLength(2);
			for (const source of contentSources) {
				// Untrusted provenance: user-attached external content, never
				// builtin/trusted-project, with capability + digest refs.
				expect(source.trust).toBe("external_untrusted");
				expect(source.scope).toBe("turn");
				expect(source.disposition).toBe("included");
				expect(source.reason).toBe("within_budget");
				expect(source.capabilityId).toBeDefined();
				expect(source.capabilityRevision).toMatch(/^rev:/);
				expect(source.capabilityBindingId).toBe(session.getCapabilityBindingId());
				expect(source.contentDigest).toMatch(/^[a-f0-9]{64}$/);
				// The label never embeds the raw URI or prompt name.
				expect(source.label).not.toContain("docs://guide");
				expect(source.label).not.toContain("summarize");
			}
			assertSnapshotMetadataOnly(snapshot);

			// Attachments are turn-scoped: the next turn starts empty.
			const preview = await session.inspectContext();
			expect(preview.snapshot.sources.some((source) => source.kind === "mcp_content")).toBe(false);

			// A second turn attaches once more and sees exactly one source.
			await session.attachMcpResource("docs", RESOURCE_ID);
			await session.prompt("again");
			const secondSnapshotId = session.getLastContextSnapshotId();
			expect(secondSnapshotId).not.toBe(snapshotId);
			const { snapshot: secondSnapshot } = await session.inspectContext({ snapshotId: secondSnapshotId });
			expect(
				secondSnapshot.sources.filter((source) => source.kind === "mcp_content"),
			).toHaveLength(1);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cancels in-flight reads and never stages aborted attachments", async () => {
		const { dir, agentDir } = tmpDir("content-cancel");
		const mock = createInMemoryContentServer({ resources: [RESOURCE_A] });
		const settingsManager = SettingsManager.inMemory(stdioContentSettings());
		try {
			const { session } = await createControlledSession({
				dir,
				agentDir,
				settingsManager,
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();
			await session.listMcpResources("docs");

			const aborted = new AbortController();
			aborted.abort();
			await expect(session.readMcpResource("docs", RESOURCE_ID, aborted.signal)).rejects.toMatchObject({
				name: "AbortError",
			});
			await expect(session.attachMcpResource("docs", RESOURCE_ID, aborted.signal)).rejects.toMatchObject({
				name: "AbortError",
			});

			// The aborted attach staged nothing; a later attach is the only one.
			await session.attachMcpResource("docs", RESOURCE_ID);
			await session.prompt("hello");
			const snapshotId = session.getLastContextSnapshotId();
			const { snapshot } = await session.inspectContext({ snapshotId });
			expect(snapshot.sources.filter((source) => source.kind === "mcp_content")).toHaveLength(1);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});
});
