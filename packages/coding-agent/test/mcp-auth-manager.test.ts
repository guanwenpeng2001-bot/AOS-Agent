import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@aos-agent/ai";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import { MCPAuthManager, type MCPAuthStartResult } from "../src/core/policy/mcp-auth-manager.ts";
import { MCPAuthStorage } from "../src/core/policy/mcp-auth-storage.ts";
import type { MCPServerConfig } from "../src/core/mcp-types.ts";

const INSTALLATION_ID = "a".repeat(64);
const ISSUER_URL = "https://auth.example.com";
const RESOURCE_URL = "https://mcp.example.com";
const SERVER_URL = "https://mcp.example.com/api";

// ---------------------------------------------------------------------------
// Fake AuthInteraction: records prompts/events, never auto-approves.
// ---------------------------------------------------------------------------

interface FakeInteractionResult {
	interaction: AuthInteraction;
	events: AuthEvent[];
	prompts: AuthPrompt[];
}

function createFakeInteraction(options: { confirm?: "allow" | "cancel" } = {}): FakeInteractionResult {
	const events: AuthEvent[] = [];
	const prompts: AuthPrompt[] = [];
	const interaction: AuthInteraction = {
		async prompt(prompt) {
			prompts.push(prompt);
			if (prompt.type === "select") {
				if (options.confirm === "cancel") {
					throw new Error("Login cancelled");
				}
				return "allow";
			}
			throw new Error(`Unexpected prompt type`);
		},
		notify(event) {
			events.push(event);
		},
	};
	return { interaction, events, prompts };
}

function authUrlFrom(events: AuthEvent[]): URL | undefined {
	const event = events.find((event) => event.type === "auth_url");
	return event !== undefined && event.type === "auth_url" ? new URL(event.url) : undefined;
}

async function waitForAuthUrl(events: AuthEvent[], timeoutMs = 5_000): Promise<URL> {
	const start = Date.now();
	while (authUrlFrom(events) === undefined) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitForAuthUrl timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return authUrlFrom(events) as URL;
}

/** Simulates the user agent completing the authorization redirect. */
async function completeBrowserStep(authUrl: URL): Promise<void> {
	await fetch(authUrl, { redirect: "follow" });
}

// ---------------------------------------------------------------------------
// Fake OAuth authorization server (loopback, HTTP).
// ---------------------------------------------------------------------------

interface FakeOAuthServer {
	origin: string;
	url: string;
	counts: { prm: number; metadata: number; authorize: number; register: number; token: number; refresh: number };
	close(): Promise<void>;
}

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

const runningServers: FakeOAuthServer[] = [];

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map((server) => server.close().catch(() => undefined)));
});

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
			if (params.get("grant_type") === "refresh_token") {
				counts.refresh += 1;
				if (params.get("refresh_token") !== "rt-1") {
					sendJson(res, 400, { error: "invalid_grant" });
					return;
				}
				sendJson(res, 200, {
					access_token: "at-refreshed",
					token_type: "Bearer",
					expires_in: 3600,
				});
				return;
			}
			sendJson(res, 400, { error: "unsupported_grant_type" });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpConfig(serverUrl: string, id = "test-server"): MCPServerConfig {
	return { id, transport: "streamable-http", url: serverUrl };
}

function stdioConfig(id = "stdio-server"): MCPServerConfig {
	return { id, transport: "stdio", command: "node" };
}

async function waitForAuthorize(
	manager: MCPAuthManager,
	serverId: string,
	serverUrl: string,
): Promise<{ result: MCPAuthStartResult; prompts: AuthPrompt[]; events: AuthEvent[] }> {
	const { interaction, prompts, events } = createFakeInteraction();
	const promise = manager.start(serverId, serverUrl, { interaction });
	const authUrl = await waitForAuthUrl(events);
	await completeBrowserStep(authUrl);
	const result = await promise;
	return { result, prompts, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCPAuthManager getProvider", () => {
	it("never resolves a provider for stdio configs", () => {
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
		});
		expect(manager.getProvider(stdioConfig())).toBeUndefined();
	});

	it("serves an already-stored credential to a fresh session's provider (shape only, no values)", async () => {
		const store = AuthStorage.inMemory();
		// Pre-seed the namespace as a previous session would have.
		const storage = new MCPAuthStorage({ store, installationId: INSTALLATION_ID, serverUrl: SERVER_URL });
		await storage.saveTokens(
			{ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600, scope: "tools" },
			{ issuer: ISSUER_URL, resource: RESOURCE_URL },
		);

		// A brand-new manager (fresh session) must serve the stored credential
		// in the SDK OAuthTokens shape without re-authorizing.
		const manager = new MCPAuthManager({ store, installationId: INSTALLATION_ID });
		const provider = manager.getProvider(httpConfig(SERVER_URL));
		expect(provider).toBeDefined();
		const tokens = await provider?.tokens();
		expect(tokens).toBeDefined();
		// Shape assertions only; token values never appear in this test's output.
		expect(typeof tokens?.access_token).toBe("string");
		expect(tokens?.token_type).toBe("Bearer");
		expect(typeof tokens?.refresh_token).toBe("string");
		expect(typeof tokens?.expires_in).toBe("number");
		expect(tokens?.scope).toBe("tools");

		// The same server id resolves one stable provider instance per session.
		expect(manager.getProvider(httpConfig(SERVER_URL))).toBe(provider);

		// URL-keyed status works without any prior session registration.
		const status = await manager.getStatus(SERVER_URL);
		expect(status).toMatchObject({ status: "authenticated" });
		expect(status).not.toHaveProperty("serverUrl");
		expect(status).not.toHaveProperty("issuer");
		expect(JSON.stringify(status)).not.toContain("at-1");
	});

	it("keeps provider instances isolated per session", async () => {
		const store = AuthStorage.inMemory();
		const first = new MCPAuthManager({ store, installationId: INSTALLATION_ID });
		const second = new MCPAuthManager({ store, installationId: INSTALLATION_ID });
		expect(first.getProvider(httpConfig(SERVER_URL))).not.toBe(second.getProvider(httpConfig(SERVER_URL)));
	});
});

describe("MCPAuthManager start / status / logout", () => {
	it("authorizes through the interaction confirm and persists a masked status", async () => {
		const fake = await startFakeOAuthServer();
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
			fetch: fetch,
		});
		const { result, prompts, events } = await waitForAuthorize(manager, "srv", fake.url);

		expect(result).toEqual({ status: "authorized" });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ type: "select" });
		expect(events.some((event) => event.type === "auth_url")).toBe(true);
		expect(fake.counts.register).toBe(1);
		expect(fake.counts.authorize).toBe(1);
		expect(fake.counts.token).toBe(1);

		const status = await manager.getStatus(fake.url);
		expect(status).toMatchObject({ status: "authenticated" });
		expect(status).not.toHaveProperty("serverUrl");
		expect(status).not.toHaveProperty("issuer");
		expect(JSON.stringify(status)).not.toContain("at-1");
		expect(JSON.stringify(status)).not.toContain("rt-1");
		expect(JSON.stringify(await manager.listStatuses())).not.toContain("at-1");
	});

	it("rejects authorization without an interaction confirm (cancel)", async () => {
		const fake = await startFakeOAuthServer();
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
			fetch: fetch,
		});
		const { interaction } = createFakeInteraction({ confirm: "cancel" });
		await expect(manager.start("srv", fake.url, { interaction })).rejects.toThrow(/cancelled/);
		expect(await manager.listStatuses()).toEqual([]);
	});

	it("returns already_authorized without prompting when the namespace holds a credential", async () => {
		const fake = await startFakeOAuthServer();
		const store = AuthStorage.inMemory();
		const manager = new MCPAuthManager({ store, installationId: INSTALLATION_ID, fetch: fetch });
		await waitForAuthorize(manager, "srv", fake.url);

		// A second session's manager must not prompt again.
		const second = new MCPAuthManager({ store, installationId: INSTALLATION_ID, fetch: fetch });
		const { interaction, prompts } = createFakeInteraction();
		const result = await second.start("srv", fake.url, { interaction });
		expect(result).toEqual({ status: "already_authorized" });
		expect(prompts).toHaveLength(0);
	});

	it("logout revokes best effort and clears status and in-memory flow state", async () => {
		const fake = await startFakeOAuthServer();
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
			fetch: fetch,
		});
		await waitForAuthorize(manager, "srv", fake.url);
		const provider = manager.getProvider(httpConfig(fake.url, "srv"));
		expect(await provider?.tokens()).toBeDefined();

		await manager.logout("srv");

		expect(await manager.getStatus(fake.url)).toBeUndefined();
		expect(await manager.listStatuses()).toEqual([]);
		// The session's provider no longer serves tokens after logout.
		expect(await provider?.tokens()).toBeUndefined();
	});

	it("fresh-session logout(serverId, serverUrl) deletes a pre-stored credential without any provider", async () => {
		const store = AuthStorage.inMemory();
		// Pre-seed the namespace as a previous session would have.
		const storage = new MCPAuthStorage({ store, installationId: INSTALLATION_ID, serverUrl: SERVER_URL });
		await storage.saveTokens(
			{ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600, scope: "tools" },
			{ issuer: ISSUER_URL, resource: RESOURCE_URL },
		);

		// A brand-new manager that never resolved a provider nor ran a flow
		// must still delete the stored credential when given the server URL.
		const manager = new MCPAuthManager({ store, installationId: INSTALLATION_ID });
		expect(manager.getProvider(stdioConfig())).toBeUndefined();
		expect(await manager.getStatus(SERVER_URL)).toBeDefined();

		await manager.logout("srv", SERVER_URL);

		expect(await manager.getStatus(SERVER_URL)).toBeUndefined();
		expect(await manager.listStatuses()).toEqual([]);
	});
});

describe("MCPAuthManager start flow options", () => {
	it("passes callbackMode/httpsCallbackUrl into the flow, replacing a provider-seam default flow", async () => {
		const fake = await startFakeOAuthServer();
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
			fetch: fetch,
		});
		// The transport provider seam creates a default (loopback) flow first;
		// an explicit start with https options must replace it instead of
		// silently running the loopback callback.
		const providerSeamFlow = manager.getProvider(httpConfig(fake.url, "srv"));
		expect(providerSeamFlow).toBeDefined();

		const prompts: AuthPrompt[] = [];
		const events: AuthEvent[] = [];
		const httpsCallbackUrl = "https://callback.example.com/mcp/callback";
		const interaction: AuthInteraction = {
			async prompt(prompt) {
				prompts.push(prompt);
				if (prompt.type === "select") {
					return "allow";
				}
				if (prompt.type === "manual_code") {
					return "test-code";
				}
				throw new Error(`Unexpected prompt type`);
			},
			notify(event) {
				events.push(event);
			},
		};
		const result = await manager.start("srv", fake.url, {
			interaction,
			callbackMode: "https",
			httpsCallbackUrl,
			timeoutMs: 5_000,
			requestTimeoutMs: 10_000,
		});
		expect(result).toEqual({ status: "authorized" });
		// The https mode took the manual-code branch, not the loopback listener.
		expect(prompts.some((prompt) => prompt.type === "manual_code")).toBe(true);
		// The authorization URL carries the fixed HTTPS redirect URI.
		const authUrl = authUrlFrom(events);
		expect(authUrl).toBeDefined();
		expect(authUrl?.searchParams.get("redirect_uri")).toBe(httpsCallbackUrl);
		expect(fake.counts.token).toBe(1);
	});

	it("applies the start timeoutMs to the callback capture (fail closed with callback_timeout)", async () => {
		const fake = await startFakeOAuthServer();
		const manager = new MCPAuthManager({
			store: AuthStorage.inMemory(),
			installationId: INSTALLATION_ID,
			fetch: fetch,
		});
		const interaction: AuthInteraction = {
			async prompt(prompt) {
				if (prompt.type === "select") {
					return "allow";
				}
				// The manual code never arrives; the flow must give up at timeoutMs.
				return new Promise<string>(() => undefined);
			},
			notify() {},
		};
		await expect(
			manager.start("srv", fake.url, {
				interaction,
				callbackMode: "https",
				httpsCallbackUrl: "https://callback.example.com/cb",
				timeoutMs: 200,
				requestTimeoutMs: 5_000,
			}),
		).rejects.toThrow(/timed out/);
		// No credential was persisted for the failed start.
		expect(await manager.listStatuses()).toEqual([]);
	});
});

describe("MCPAuthManager refresh/401 provider seam", () => {
	it("refreshes stored tokens through the provider and persists the rotation", async () => {
		const fake = await startFakeOAuthServer();
		const store = AuthStorage.inMemory();
		const manager = new MCPAuthManager({ store, installationId: INSTALLATION_ID, fetch: fetch });
		await waitForAuthorize(manager, "srv", fake.url);

		// Simulate the transport's 401 handling: the SDK auth() orchestrator is
		// driven with the session's provider; stored tokens + refresh_token make
		// it take the refresh grant instead of an interactive flow.
		const provider = manager.getProvider(httpConfig(fake.url, "srv"));
		const result = await auth(provider!, { serverUrl: fake.url, fetchFn: fetch });
		expect(result).toBe("AUTHORIZED");
		expect(fake.counts.refresh).toBe(1);
		expect(fake.counts.authorize).toBe(1);

		// The rotated tokens were persisted into the namespace through the
		// provider's saveTokens; the next session sees them.
		const storage = new MCPAuthStorage({ store, installationId: INSTALLATION_ID, serverUrl: fake.url });
		const stored = await storage.readTokens();
		expect(stored).toBeDefined();
		expect(stored?.access).toBe("at-refreshed");

		const fresh = new MCPAuthManager({ store, installationId: INSTALLATION_ID, fetch: fetch });
		const tokens = await fresh.getProvider(httpConfig(fake.url, "srv"))?.tokens();
		expect(tokens?.access_token).toBe("at-refreshed");
	});
});
