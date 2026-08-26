import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
} from "@aos-agent/ai/compat";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import { CapabilityRegistry } from "../src/core/capability-registry.ts";
import { MCPAuthStorage } from "../src/core/mcp-auth-storage.ts";
import { SessionManager, type SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController, type RpcHostOutputSink, type RpcWireRecord } from "../src/modes/rpc/rpc-host.ts";
import type {
	RpcExtensionUIRequest,
	RpcMcpAuthResponse,
} from "../src/modes/rpc/rpc-types.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const INSTALLATION_ID = "a".repeat(64);
const ISSUER_URL = "https://auth.example.com";
const RESOURCE_URL = "https://mcp.example.com";
const SERVER_URL = "https://mcp.example.com/api";

// ---------------------------------------------------------------------------
// Session + RPC host harness with a session-scoped MCP OAuth manager.
// ---------------------------------------------------------------------------

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `aos-rpc-mcp-auth-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { dir, agentDir };
}

function capabilitySettingsWithMcp(
	httpServers: Array<{ id: string; url: string }> = [],
	opts: { selectServers?: boolean } = {},
): {
	capabilities: { defaultProfile: string; profiles: Record<string, { rules: unknown[] }> };
	mcp: { servers: Record<string, unknown> };
} {
	return {
		capabilities: {
			defaultProfile: "default",
			profiles: {
				default: {
					// No mcp_server rules by default: servers are only registered so
					// the auth gates can inspect their transport/URL, and are never
					// selected by the binding (MCP kinds default to deny) and
					// therefore never connected. `selectServers` opts into one
					// allow rule per configured HTTP test server, so the binding
					// selects only those servers and never the stdio docs fixture.
					rules:
						opts.selectServers === true
							? httpServers.map((server) => ({
									selector: { kind: "mcp_server", mcpServerId: server.id },
									action: "allow",
								}))
							: [],
				},
			},
		},
		mcp: {
			servers: {
				docs: { transport: "stdio", command: "node" },
				...Object.fromEntries(
					httpServers.map((server) => [
						server.id,
						{ transport: "streamable-http", url: server.url },
					]),
				),
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

interface RpcMcpAuthHarness {
	controller: RpcHostController;
	session: AgentSession;
	streamCalls: { count: number };
	cleanup: () => Promise<void>;
}

/**
 * In-process output capture for the extension-UI bridge: records every
 * emitted wire record and lets tests await specific records.
 */
interface CapturedSink {
	records: RpcWireRecord[];
	waitFor(predicate: (record: RpcWireRecord) => boolean, timeoutMs?: number): Promise<RpcWireRecord>;
	sink: RpcHostOutputSink;
}

function createCapturedSink(timeoutMs = 10_000): CapturedSink {
	const records: RpcWireRecord[] = [];
	const waiters: Array<{
		predicate: (record: RpcWireRecord) => boolean;
		resolve: (record: RpcWireRecord) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	const sink: RpcHostOutputSink = {
		publish(record: RpcWireRecord): void {
			records.push(record);
			for (let i = waiters.length - 1; i >= 0; i -= 1) {
				const waiter = waiters[i];
				if (!waiter.predicate(record)) continue;
				waiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(record);
			}
		},
	};
	return {
		records,
		sink,
		waitFor(predicate, waitTimeoutMs = timeoutMs) {
			const existing = records.find(predicate);
			if (existing !== undefined) return Promise.resolve(existing);
			return new Promise<RpcWireRecord>((resolve, reject) => {
				const waiter = {
					predicate,
					resolve,
					timer: setTimeout(() => {
						const index = waiters.indexOf(waiter);
						if (index !== -1) waiters.splice(index, 1);
						reject(new Error(`Timed out waiting for an extension_ui_request record`));
					}, waitTimeoutMs),
				};
				waiters.push(waiter);
			});
		},
	};
}

function isExtensionUIRequest(record: RpcWireRecord, method: string): record is RpcExtensionUIRequest {
	return record.type === "extension_ui_request" && record.method === method;
}

// ---------------------------------------------------------------------------
// Fake OAuth authorization server (loopback, HTTP). No real OAuth/browser.
// ---------------------------------------------------------------------------

interface FakeOAuthServer {
	origin: string;
	url: string;
	counts: { prm: number; metadata: number; authorize: number; register: number; token: number; refresh: number };
	close(): Promise<void>;
}

const runningServers: FakeOAuthServer[] = [];

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map((server) => server.close().catch(() => undefined)));
});

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		Connection: "close",
	});
	res.end(payload);
}

async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
	const counts = { prm: 0, metadata: 0, authorize: 0, register: 0, token: 0, refresh: 0 };
	let origin = "http://127.0.0.1";
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			counts.prm += 1;
			sendJson(res, 200, {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
			});
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			counts.metadata += 1;
			sendJson(res, 200, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
			});
			return;
		}
		if (url.pathname === "/authorize") {
			counts.authorize += 1;
			const redirectUri = url.searchParams.get("redirect_uri");
			if (redirectUri === null) {
				sendJson(res, 400, { error: "invalid_request" });
				return;
			}
			const state = url.searchParams.get("state") ?? "";
			res.writeHead(302, {
				Location: `${redirectUri}?code=test-code&state=${state}`,
				Connection: "close",
			});
			res.end();
			return;
		}
		if (url.pathname === "/register") {
			counts.register += 1;
			const body = JSON.parse(await readBody(req));
			sendJson(res, 201, {
				client_id: "test-client",
				client_id_issued_at: 1_700_000_000,
				redirect_uris: body.redirect_uris ?? [],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code"],
				response_types: ["code"],
			});
			return;
		}
		if (url.pathname === "/token") {
			const params = new URLSearchParams(await readBody(req));
			if (params.get("grant_type") === "authorization_code") {
				counts.token += 1;
				if (
					params.get("code") !== "test-code" ||
					params.get("code_verifier") === null ||
					params.get("redirect_uri") === null
				) {
					sendJson(res, 400, { error: "invalid_grant" });
					return;
				}
				sendJson(res, 200, {
					access_token: "at-1",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "rt-1",
				});
				return;
			}
			sendJson(res, 400, { error: "unsupported_grant_type" });
			return;
		}
		// MCP JSON-RPC endpoint (same origin as the OAuth resource): lets a
		// binding-selected server complete the initialize/tools/list handshake
		// so capability discovery succeeds against the fake endpoint.
		if (url.pathname === "/mcp" && req.method === "POST") {
			const body = JSON.parse(await readBody(req));
			const method = body.method;
			if (method === "initialize") {
				sendJson(res, 200, {
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {}, resources: {}, prompts: {} },
						serverInfo: { name: "fake-mcp", version: "1.0.0" },
					},
				});
				return;
			}
			if (method === "notifications/initialized") {
				// 200 application/json (not 202): the SDK only opens the SSE GET
				// stream after a 202-accepted initialized notification, and the
				// fake endpoint answers GET with 404, which would degrade the
				// lifecycle. A plain 200 JSON body keeps the client request-only.
				sendJson(res, 200, {});
				return;
			}
			if (method === "tools/list") {
				sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
				return;
			}
			if (method === "resources/list") {
				sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { resources: [] } });
				return;
			}
			if (method === "resources/templates/list") {
				sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { resourceTemplates: [] } });
				return;
			}
			if (method === "prompts/list") {
				sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { prompts: [] } });
				return;
			}
			sendJson(res, 400, {
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32601, message: "method not found" },
			});
			return;
		}
		sendJson(res, 404, { error: "not_found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
	const fake: FakeOAuthServer = {
		origin,
		url: `${origin}/mcp`,
		counts,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
	runningServers.push(fake);
	return fake;
}

/** Simulates the user agent completing the authorization redirect. */
async function completeBrowserStep(authUrl: string): Promise<void> {
	await fetch(authUrl, { redirect: "follow" });
}

async function createRpcMcpAuthHarness(opts: {
	seedCredential?: boolean;
	settingsManager: SettingsManager;
	attachSink?: RpcHostOutputSink;
}): Promise<RpcMcpAuthHarness> {
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
	const store = AuthStorage.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: opts.settingsManager,
		cwd: dir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		capabilityRegistry: new CapabilityRegistry(identity),
		mcpAuthManagerOptions: { store, installationId: INSTALLATION_ID },
	});
	if (opts.seedCredential === true) {
		const storage = new MCPAuthStorage({ store, installationId: INSTALLATION_ID, serverUrl: SERVER_URL });
		await storage.saveTokens(
			{ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600, scope: "tools" },
			{ issuer: ISSUER_URL, resource: RESOURCE_URL },
		);
	}
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
	if (opts.attachSink !== undefined) {
		controller.attach(opts.attachSink);
	}
	await session.whenCapabilitiesReady();
	return {
		controller,
		session,
		streamCalls,
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

function authError(response: unknown): { code: string; message: string } {
	expect(response).toMatchObject({ type: "response", success: false });
	return (response as Extract<RpcMcpAuthResponse, { success: false }>).error;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RPC MCP OAuth wire contract (mcp.auth.*)", () => {
	it("fails closed with the fixed interaction_required error for headless start", async () => {
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp()),
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: SERVER_URL,
			});
			expect(start).toMatchObject({
				type: "response",
				command: "mcp.auth.start",
				success: false,
			});
			const error = authError(start);
			// Stable fixed code and fixed template message; never raw text or the
			// requested URL.
			expect(error.code).toBe("mcp_auth_interaction_required");
			expect(error.message).toContain("interaction");
			expect(JSON.stringify(start)).not.toContain(SERVER_URL);
			// No browser, no flow, no model run.
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("reports masked credential status and supports logout, rejecting stdio servers", async () => {
		const harness = await createRpcMcpAuthHarness({
			seedCredential: true,
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp()),
		});
		try {
			const { controller } = harness;
			const dispatch = (command: Parameters<typeof controller.dispatch>[0]): Promise<unknown> =>
				controller.dispatch(command);

			// --- mcp.auth.status: authorized with masked credential ---
			const status = (await dispatch({
				type: "mcp.auth.status",
				serverId: "srv",
				serverUrl: SERVER_URL,
			})) as RpcMcpAuthResponse;
			expect(status).toMatchObject({ type: "response", command: "mcp.auth.status", success: true });
			const statusData = (
				status as Extract<RpcMcpAuthResponse, { command: "mcp.auth.status"; success: true }>
			).data;
			expect(statusData).toMatchObject({
				status: "authenticated",
				credential: { status: "authenticated" },
			});
			expect(statusData.credential).not.toHaveProperty("hasRefreshToken");
			expect(statusData.credential).not.toHaveProperty("scope");
			// Redaction: no token values, no URL, no issuer/resource, no raw URI.
			const statusJson = JSON.stringify(status);
			expect(statusJson).not.toContain("at-1");
			expect(statusJson).not.toContain("rt-1");
			expect(statusJson).not.toContain(SERVER_URL);
			expect(statusJson).not.toContain(ISSUER_URL);
			expect(statusJson).not.toContain(RESOURCE_URL);

			// --- mcp.auth.list: masked entries only ---
			const list = (await dispatch({ type: "mcp.auth.list" })) as RpcMcpAuthResponse;
			expect(list).toMatchObject({ type: "response", command: "mcp.auth.list", success: true });
			const listData = (list as Extract<RpcMcpAuthResponse, { command: "mcp.auth.list"; success: true }>).data;
			expect(listData.credentials).toHaveLength(1);
			const listJson = JSON.stringify(list);
			expect(listJson).not.toContain("at-1");
			expect(listJson).not.toContain("rt-1");
			expect(listJson).not.toContain(SERVER_URL);
			expect(listJson).not.toContain(ISSUER_URL);
			expect(listJson).not.toContain(RESOURCE_URL);

			// --- stdio servers are fixed-rejected for status and logout ---
			const stdioStatus = await dispatch({
				type: "mcp.auth.status",
				serverId: "docs",
				serverUrl: SERVER_URL,
			});
			expect(stdioStatus).toMatchObject({ type: "response", command: "mcp.auth.status", success: false });
			expect(authError(stdioStatus).code).toBe("mcp_auth_stdio_not_applicable");
			expect(authError(stdioStatus).message).toContain("stdio");
			const stdioLogout = await dispatch({
				type: "mcp.auth.logout",
				serverId: "docs",
				serverUrl: SERVER_URL,
			});
			expect(stdioLogout).toMatchObject({ type: "response", command: "mcp.auth.logout", success: false });
			expect(authError(stdioLogout).code).toBe("mcp_auth_stdio_not_applicable");

			// --- mcp.auth.logout deletes the namespaced credential ---
			const logout = (await dispatch({
				type: "mcp.auth.logout",
				serverId: "srv",
				serverUrl: SERVER_URL,
			})) as RpcMcpAuthResponse;
			expect(logout).toMatchObject({ type: "response", command: "mcp.auth.logout", success: true });

			// --- status flips to required and list is empty after logout ---
			const afterLogout = (await dispatch({
				type: "mcp.auth.status",
				serverId: "srv",
				serverUrl: SERVER_URL,
			})) as RpcMcpAuthResponse;
			expect(afterLogout).toMatchObject({
				type: "response",
				command: "mcp.auth.status",
				success: true,
				data: { status: "required" },
			});
			const emptyList = (await dispatch({ type: "mcp.auth.list" })) as RpcMcpAuthResponse;
			expect(emptyList).toMatchObject({ type: "response", command: "mcp.auth.list", success: true });
			const emptyListData = (
				emptyList as Extract<RpcMcpAuthResponse, { command: "mcp.auth.list"; success: true }>
			).data;
			expect(emptyListData.credentials).toEqual([]);

			// No model stream was ever started.
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed immediately for interactive start without an output sink", async () => {
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp()),
		});
		try {
			// `interactive: true` without an attached output sink can never
			// deliver dialogs or the one-shot authorization URL, so it must
			// fail closed immediately instead of creating dialogs that could
			// only time out.
			const startedAt = Date.now();
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: SERVER_URL,
				interactive: true,
			});
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_interaction_required");
			expect(JSON.stringify(start)).not.toContain(SERVER_URL);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("denies logout when the execution policy denies the mcp.auth operation", async () => {
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			seedCredential: true,
			settingsManager: SettingsManager.inMemory({
				...capabilitySettingsWithMcp(),
				executionPolicy: denyMcpAuthPolicySettings(),
			}),
			attachSink: capture.sink,
		});
		try {
			const logout = (await harness.controller.dispatch({
				type: "mcp.auth.logout",
				serverId: "srv",
				serverUrl: SERVER_URL,
			})) as RpcMcpAuthResponse;
			expect(logout).toMatchObject({ type: "response", command: "mcp.auth.logout", success: false });
			expect(authError(logout).code).toBe("mcp_auth_policy_denied");
			expect(JSON.stringify(logout)).not.toContain(SERVER_URL);
			// The denied logout never deleted the namespaced credential: status
			// still reports authorized and the masked credential survives.
			const status = (await harness.controller.dispatch({
				type: "mcp.auth.status",
				serverId: "srv",
				serverUrl: SERVER_URL,
			})) as RpcMcpAuthResponse;
			expect(status).toMatchObject({
				type: "response",
				command: "mcp.auth.status",
				success: true,
				data: { status: "authenticated" },
			});
			const audits = authAuditEntries(harness.session);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				serverId: "srv",
				operation: "auth",
				outcome: "failed",
				reasonCode: "policy_denied",
			});
			expect(JSON.stringify(audits)).not.toContain(SERVER_URL);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("authorizes interactively (loopback) and delivers the auth URL exactly once as a dedicated record", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const startPromise = harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});

			// Consent dialog: the bridge maps the flow's allow/cancel select to
			// a confirm dialog.
			const confirm = (await capture.waitFor((record) => isExtensionUIRequest(record, "confirm"))) as RpcExtensionUIRequest;
			expect(confirm).toMatchObject({ type: "extension_ui_request", method: "confirm" });
			await harness.controller.handleExtensionUIResponse({
				type: "extension_ui_response",
				id: confirm.id,
				confirmed: true,
			});

			// Dedicated one-shot authorization URL record.
			const authUrlRecord = (await capture.waitFor((record) => isExtensionUIRequest(record, "auth_url"))) as Extract<RpcExtensionUIRequest, { method: "auth_url" }>;
			expect(authUrlRecord.url).toMatch(/^https?:\/\//);
			expect(authUrlRecord.url).toContain(fake.origin);

			// Simulate the user agent completing the redirect (loopback
			// callback with the flow's own state).
			await completeBrowserStep(authUrlRecord.url);

			const response = (await startPromise) as RpcMcpAuthResponse;
			expect(response).toMatchObject({
				type: "response",
				command: "mcp.auth.start",
				success: true,
				data: { status: "authorized" },
			});
			expect(fake.counts.authorize).toBe(1);
			expect(fake.counts.token).toBe(1);

			// The authorization URL appears exactly once, only inside the
			// dedicated auth_url record, and never in the response or any other
			// record. Tokens never cross the wire.
			const authUrlRecords = capture.records.filter((record) => isExtensionUIRequest(record, "auth_url"));
			expect(authUrlRecords).toHaveLength(1);
			expect(JSON.stringify(response)).not.toContain(authUrlRecord.url);
			expect(JSON.stringify(capture.records)).not.toContain("at-1");
			expect(JSON.stringify(capture.records)).not.toContain("rt-1");

			// The stored credential is masked through the status surface.
			const status = (await harness.controller.dispatch({
				type: "mcp.auth.status",
				serverId: "srv",
				serverUrl: fake.url,
			})) as RpcMcpAuthResponse;
			expect(status).toMatchObject({
				type: "response",
				command: "mcp.auth.status",
				success: true,
				data: { status: "authenticated", credential: { status: "authenticated" } },
			});
			expect(JSON.stringify(status)).not.toContain("at-1");
			expect(JSON.stringify(status)).not.toContain(fake.origin);

			// The successful authorization is audited allowlist-only: serverId,
			// operation, outcome, binding ids, timestamp; never the URL or tokens.
			const audits = authAuditEntries(harness.session);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				serverId: "srv",
				operation: "auth",
				outcome: "success",
			});
			expect(typeof audits[0].capabilityBindingId).toBe("string");
			expect(typeof audits[0].policyBindingId).toBe("string");
			expect(typeof audits[0].timestamp).toBe("string");
			const auditsJson = JSON.stringify(audits);
			expect(auditsJson).not.toContain(fake.origin);
			expect(auditsJson).not.toContain("at-1");
			expect(auditsJson).not.toContain("rt-1");

			// No model stream was ever started.
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("authorizes interactively through the https manual-code path", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const startPromise = harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
				callbackMode: "https",
				httpsCallbackUrl: "https://callback.example.com/callback",
			});

			const confirm = (await capture.waitFor((record) => isExtensionUIRequest(record, "confirm"))) as RpcExtensionUIRequest;
			await harness.controller.handleExtensionUIResponse({
				type: "extension_ui_response",
				id: confirm.id,
				confirmed: true,
			});

			// The dedicated auth_url record is still emitted (the user opens it
			// in their own browser) but no loopback callback runs.
			const authUrlRecord = (await capture.waitFor((record) => isExtensionUIRequest(record, "auth_url"))) as Extract<RpcExtensionUIRequest, { method: "auth_url" }>;
			expect(authUrlRecord.url).toContain(fake.origin);

			// Manual code entry through the input dialog.
			const input = (await capture.waitFor((record) => isExtensionUIRequest(record, "input"))) as Extract<RpcExtensionUIRequest, { method: "input" }>;
			await harness.controller.handleExtensionUIResponse({
				type: "extension_ui_response",
				id: input.id,
				value: "test-code",
			});

			const response = (await startPromise) as RpcMcpAuthResponse;
			expect(response).toMatchObject({
				type: "response",
				command: "mcp.auth.start",
				success: true,
				data: { status: "authorized" },
			});
			expect(fake.counts.authorize).toBe(0);
			expect(fake.counts.token).toBe(1);

			// URL delivered exactly once and only in the dedicated record.
			const authUrlRecords = capture.records.filter((record) => isExtensionUIRequest(record, "auth_url"));
			expect(authUrlRecords).toHaveLength(1);
			expect(JSON.stringify(response)).not.toContain(authUrlRecord.url);
			expect(JSON.stringify(capture.records)).not.toContain("at-1");
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("maps an interactive consent decline to mcp_auth_cancelled", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const startPromise = harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			const confirm = (await capture.waitFor((record) => isExtensionUIRequest(record, "confirm"))) as RpcExtensionUIRequest;
			await harness.controller.handleExtensionUIResponse({
				type: "extension_ui_response",
				id: confirm.id,
				confirmed: false,
			});
			const response = (await startPromise) as RpcMcpAuthResponse;
			expect(response).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(response).code).toBe("mcp_auth_cancelled");
			expect(authError(response).message).toContain("cancelled");
			// The flow never reached the authorization server or the token
			// endpoint after the decline.
			expect(fake.counts.authorize).toBe(0);
			expect(fake.counts.token).toBe(0);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("settles a pending interactive start on host detach with mcp_auth_cancelled", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const startPromise = harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			const confirm = (await capture.waitFor((record) => isExtensionUIRequest(record, "confirm"))) as RpcExtensionUIRequest;
			expect(confirm).toBeDefined();
			// The transport detaches while the consent dialog is pending: the
			// pending dialog is rejected and the flow fails closed.
			await harness.controller.detachTransport();
			const response = (await startPromise) as RpcMcpAuthResponse;
			expect(response).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(response).code).toBe("mcp_auth_cancelled");
			expect(fake.counts.token).toBe(0);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("settles a pending interactive start on host shutdown with mcp_auth_cancelled", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const startPromise = harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			const confirm = (await capture.waitFor((record) => isExtensionUIRequest(record, "confirm"))) as RpcExtensionUIRequest;
			expect(confirm).toBeDefined();
			// Host shutdown while the consent dialog is pending settles the
			// pending dialog instead of waiting for its timeout.
			await harness.controller.shutdown();
			const response = (await startPromise) as RpcMcpAuthResponse;
			expect(response).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(["mcp_auth_cancelled", "mcp_auth_aborted"]).toContain(authError(response).code);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

/** Execution policy settings whose `mcp.auth` approval is hard-deny. */
function denyMcpAuthPolicySettings(): {
	defaultProfile: string;
	profiles: Record<string, unknown>;
} {
	return {
		defaultProfile: "default",
		profiles: {
			default: {
				id: "default",
				enforcement: "host",
				defaultAction: "allow",
				workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
				process: {
					action: "allow",
					inheritEnvironment: false,
					allowEnvironment: [],
					cwdScopes: ["workspace"],
					timeoutMs: 60_000,
				},
				network: { action: "allow", allowDestinations: [] },
				credentials: { action: "deny", allowNames: [] },
				// Only the `mcp.auth` operation is denied: network must stay allowed
				// so a selected server can complete startup authorization and the
				// test body can reach the auth gate. A network deny would instead
				// fail harness capability discovery before the start command runs.
				approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "allow", mcp: "deny" },
				rules: [],
			},
		},
	};
}

/** Allowlist-only auth audit entries of the session's MCP operation trail. */
function authAuditEntries(session: AgentSession): Array<Record<string, unknown>> {
	return session.sessionRead
			.getEntries()
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === "mcp.content.audit",
			)
			.map((entry) => (entry.data ?? {}) as Record<string, unknown>)
			.filter((data) => data.operation === "auth");
	}

	it("fails closed for a start against an unregistered server id without any discovery", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp()),
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "ghost",
				serverUrl: fake.url,
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_invalid_config");
			// No OAuth discovery ever ran against the endpoint and the URL never
			// leaks into the response.
			expect(fake.counts.prm).toBe(0);
			expect(JSON.stringify(start)).not.toContain(fake.origin);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed for an untrusted project server without any discovery", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const temp = tmpDir("untrusted");
		mkdirSync(join(temp.dir, ".aos-agent"), { recursive: true });
		writeFileSync(
			join(temp.dir, ".aos-agent", "settings.json"),
			JSON.stringify({ mcp: { servers: { srv: { transport: "streamable-http", url: fake.url } } } }),
		);
		const settingsManager = SettingsManager.create(temp.dir, temp.agentDir, { projectTrusted: false });
		const harness = await createRpcMcpAuthHarness({
			settingsManager,
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_capability_denied");
			expect(fake.counts.prm).toBe(0);
			expect(JSON.stringify(start)).not.toContain(fake.origin);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed for a configured but unselected server without any discovery", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			// The server is registered and trusted but the binding never selected
			// it (MCP kinds default to deny), so OAuth must not run.
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp([{ id: "srv", url: fake.url }])),
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_capability_denied");
			// No OAuth discovery, no consent dialog, no URL leak.
			expect(fake.counts.prm).toBe(0);
			expect(capture.records.some((record) => isExtensionUIRequest(record, "confirm"))).toBe(false);
			expect(JSON.stringify(start)).not.toContain(fake.origin);
			expect(harness.streamCalls.count).toBe(0);
			// The failed attempt is audited with a fixed reason code only.
			const audits = authAuditEntries(harness.session);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				serverId: "srv",
				operation: "auth",
				outcome: "failed",
				reasonCode: "capability_denied",
			});
			expect(JSON.stringify(audits)).not.toContain(fake.origin);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed when the requested endpoint differs from the registered server endpoint", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(
				capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
			),
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: "https://other.example.invalid/mcp",
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_resource_mismatch");
			// The registered endpoint is the source of truth: no OAuth discovery
			// ran and neither URL leaks into the response.
			expect(fake.counts.prm).toBe(0);
			expect(JSON.stringify(start)).not.toContain(fake.origin);
			expect(JSON.stringify(start)).not.toContain("other.example.invalid");
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed when the execution policy denies the mcp.auth operation", async () => {
		const fake = await startFakeOAuthServer();
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory({
				...capabilitySettingsWithMcp([{ id: "srv", url: fake.url }], { selectServers: true }),
				executionPolicy: denyMcpAuthPolicySettings(),
			}),
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "srv",
				serverUrl: fake.url,
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_policy_denied");
			expect(fake.counts.prm).toBe(0);
			expect(JSON.stringify(start)).not.toContain(fake.origin);
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects mcp.auth.start for a stdio server with the fixed stdio code", async () => {
		const capture = createCapturedSink();
		const harness = await createRpcMcpAuthHarness({
			settingsManager: SettingsManager.inMemory(capabilitySettingsWithMcp()),
			attachSink: capture.sink,
		});
		try {
			const start = await harness.controller.dispatch({
				type: "mcp.auth.start",
				serverId: "docs",
				serverUrl: SERVER_URL,
				interactive: true,
			});
			expect(start).toMatchObject({ type: "response", command: "mcp.auth.start", success: false });
			expect(authError(start).code).toBe("mcp_auth_stdio_not_applicable");
			expect(harness.streamCalls.count).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});
});
