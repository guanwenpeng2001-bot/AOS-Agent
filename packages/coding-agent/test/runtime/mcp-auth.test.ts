import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@aos-agent/ai";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	canonicalMCPResourceUrl,
	classifyMCPAuthError,
	discoverMCPOAuth,
	isCanonicalMCPResourceMatch,
	MCPAuthError,
	MCPAuthFlow,
	MCP_OAUTH_LOOPBACK_CALLBACK_PATH,
} from "../../src/core/policy/mcp-auth.ts";

/** Fake interaction driven by the test; records prompts and events. */
interface FakeInteractionResult {
	interaction: AuthInteraction;
	events: AuthEvent[];
	prompts: AuthPrompt[];
}

function createFakeInteraction(
	options: { confirm?: "allow" | "cancel"; manualCode?: string; promptError?: boolean } = {},
): FakeInteractionResult {
	const events: AuthEvent[] = [];
	const prompts: AuthPrompt[] = [];
	const interaction: AuthInteraction = {
		async prompt(prompt) {
			prompts.push(prompt);
			if (options.promptError === true) {
				throw new Error("prompt failed");
			}
			if (prompt.type === "select") {
				if (options.confirm === "cancel") {
					throw new Error("Login cancelled");
				}
				return "allow";
			}
			if (prompt.type === "manual_code") {
				return options.manualCode ?? "manual-code";
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

interface FakeOAuthServerOptions {
	/** Advertise RFC 9728 protected resource metadata; default true. */
	prm?: boolean;
	/** PRM `resource` claim; default `<origin>/mcp`. */
	resource?: string;
	/** PRM `authorization_servers`; default `[origin]`. */
	authorizationServers?: string[];
	/** Serve authorization server metadata; default true. */
	metadata?: boolean;
	/** Overrides merged over the default authorization server metadata. */
	metadataOverrides?: Record<string, unknown>;
	/** Code issued by /authorize and accepted by /token; default "test-code". */
	expectedCode?: string;
	/** State echoed by /authorize; default echoes the received state. */
	stateOverride?: string;
	/** /authorize redirects with `error=...` instead of a code. */
	authorizeError?: string;
	/** authorization_code grant at /token always fails. */
	tokenError?: "invalid_grant";
	/** refresh_token grant behavior; default "ok". */
	refreshBehavior?: "invalid_grant" | "ok";
	/** refresh_token grant rotates the refresh token; default false. */
	refreshRotates?: boolean;
	/** Expected refresh token value; default "rt-1". */
	refreshToken?: string;
	/** /register fails; default false. */
	registrationError?: boolean;
}

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

async function startFakeOAuthServer(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
	const counts = { prm: 0, metadata: 0, authorize: 0, register: 0, token: 0, refresh: 0 };
	let origin = "http://127.0.0.1";
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			counts.prm += 1;
			if (options.prm === false) {
				sendJson(res, 404, { error: "not_found" });
				return;
			}
			sendJson(res, 200, {
				resource: options.resource ?? `${origin}/mcp`,
				...(options.authorizationServers !== undefined
					? { authorization_servers: options.authorizationServers }
					: { authorization_servers: [origin] }),
			});
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			counts.metadata += 1;
			if (options.metadata === false) {
				sendJson(res, 404, { error: "not_found" });
				return;
			}
			const base = {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
			};
			sendJson(res, 200, { ...base, ...options.metadataOverrides });
			return;
		}
		if (url.pathname === "/authorize") {
			counts.authorize += 1;
			const redirectUri = url.searchParams.get("redirect_uri");
			if (redirectUri === null) {
				sendJson(res, 400, { error: "invalid_request" });
				return;
			}
			if (options.authorizeError !== undefined) {
				res.writeHead(302, { Location: `${redirectUri}?error=${options.authorizeError}`, Connection: "close" });
				res.end();
				return;
			}
			const state = url.searchParams.get("state") ?? "";
			const echoedState = options.stateOverride ?? state;
			res.writeHead(302, {
				Location: `${redirectUri}?code=${options.expectedCode ?? "test-code"}&state=${echoedState}`,
				Connection: "close",
			});
			res.end();
			return;
		}
		if (url.pathname === "/register") {
			counts.register += 1;
			if (options.registrationError === true) {
				sendJson(res, 400, { error: "invalid_client_metadata" });
				return;
			}
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
				if (options.tokenError === "invalid_grant") {
					sendJson(res, 400, { error: "invalid_grant" });
					return;
				}
				if (
					params.get("code") !== (options.expectedCode ?? "test-code") ||
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
				if (
					options.refreshBehavior === "invalid_grant" ||
					params.get("refresh_token") !== (options.refreshToken ?? "rt-1")
				) {
					sendJson(res, 400, { error: "invalid_grant" });
					return;
				}
				sendJson(res, 200, {
					access_token: "at-refreshed",
					token_type: "Bearer",
					expires_in: 3600,
					...(options.refreshRotates === true ? { refresh_token: "rt-2" } : {}),
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

function createFlow(server: FakeOAuthServer, interaction: AuthInteraction, options: Record<string, unknown> = {}) {
	return new MCPAuthFlow({
		serverId: "test-server",
		serverUrl: server.url,
		interaction,
		...options,
	});
}

describe("MCPAuthFlow loopback flow", () => {
	it("runs discovery, DCR, PKCE + state authorization, loopback callback, and code exchange", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction, events, prompts } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		const authUrl = await waitForAuthUrl(events);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("code_challenge")).not.toBeNull();
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("client_id")).toBe("test-client");
		const state = authUrl.searchParams.get("state");
		expect(state).not.toBeNull();
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		expect(redirectUri).not.toBeNull();
		const redirect = new URL(redirectUri as string);
		expect(redirect.hostname).toBe("127.0.0.1");
		expect(redirect.pathname).toBe(MCP_OAUTH_LOOPBACK_CALLBACK_PATH);

		await completeBrowserStep(authUrl);
		await expect(promise).resolves.toEqual({ status: "authorized" });

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ type: "select" });
		expect(fake.counts.prm).toBeGreaterThan(0);
		expect(fake.counts.metadata).toBeGreaterThan(0);
		expect(fake.counts.register).toBe(1);
		expect(fake.counts.authorize).toBe(1);
		expect(fake.counts.token).toBe(1);
		expect(flow.provider.tokens()).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
		expect(flow.provider.clientInformation()).toMatchObject({ client_id: "test-client" });
	});

	it("rejects a second authorize() call (one-shot)", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction, events } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		await completeBrowserStep(await waitForAuthUrl(events));
		await expect(promise).resolves.toEqual({ status: "authorized" });

		await expect(flow.authorize()).rejects.toMatchObject({ kind: "flow_used", mcpKind: "auth_required" });
	});

	it("cancelling the confirm prompt rejects with user_cancelled and never exchanges", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction } = createFakeInteraction({ confirm: "cancel" });
		const flow = createFlow(fake, interaction);

		await expect(flow.authorize()).rejects.toMatchObject({ kind: "user_cancelled", mcpKind: "auth_required" });
		expect(fake.counts.token).toBe(0);
		expect(fake.counts.authorize).toBe(0);
	});

	it("rejects with state_mismatch when the callback state does not match", async () => {
		const fake = await startFakeOAuthServer({ stateOverride: "wrong-state" });
		const { interaction, events } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		// Attach the rejection handler before the browser step: the callback can
		// reject the flow while the test is still awaiting the browser fetch.
		const assertion = expect(promise).rejects.toMatchObject({ kind: "state_mismatch", mcpKind: "auth_required" });
		await completeBrowserStep(await waitForAuthUrl(events));
		await assertion;
	});

	it("rejects with user_cancelled when the authorization server returns access_denied", async () => {
		const fake = await startFakeOAuthServer({ authorizeError: "access_denied" });
		const { interaction, events } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		const assertion = expect(promise).rejects.toMatchObject({ kind: "user_cancelled" });
		await completeBrowserStep(await waitForAuthUrl(events));
		await assertion;
	});

	it("times out waiting for the callback and closes the listener", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction, events } = createFakeInteraction();
		const flow = createFlow(fake, interaction, { timeoutMs: 250 });

		const promise = flow.authorize();
		await waitForAuthUrl(events);
		await expect(promise).rejects.toMatchObject({ kind: "callback_timeout", mcpKind: "auth_required" });
	});

	it("aborts with an AbortError when the caller signal fires during capture", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction, events } = createFakeInteraction();
		const controller = new AbortController();
		const flow = createFlow(fake, interaction, { signal: controller.signal });

		const promise = flow.authorize();
		await waitForAuthUrl(events);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction } = createFakeInteraction();
		const controller = new AbortController();
		controller.abort();
		const flow = createFlow(fake, interaction, { signal: controller.signal });

		await expect(flow.authorize()).rejects.toMatchObject({ name: "AbortError" });
		expect(fake.counts.prm).toBe(0);
	});
});

describe("MCPAuthFlow token refresh and retry mapping", () => {
	it("refreshes stored tokens without any interaction", async () => {
		const fake = await startFakeOAuthServer({ refreshRotates: true });
		const { interaction, events, prompts } = createFakeInteraction();
		const flow = createFlow(fake, interaction);
		await flow.provider.saveTokens({
			access_token: "at-old",
			token_type: "Bearer",
			expires_in: 0,
			refresh_token: "rt-1",
		});

		await expect(flow.authorize()).resolves.toEqual({ status: "authorized" });

		expect(prompts).toHaveLength(0);
		expect(events).toHaveLength(0);
		expect(fake.counts.refresh).toBe(1);
		expect(fake.counts.token).toBe(0);
		expect(flow.provider.tokens()).toMatchObject({ access_token: "at-refreshed", refresh_token: "rt-2" });
	});

	it("retries exactly once after an invalid_grant refresh failure with a fresh authorization", async () => {
		const fake = await startFakeOAuthServer({ refreshBehavior: "invalid_grant" });
		const { interaction, events, prompts } = createFakeInteraction();
		const flow = createFlow(fake, interaction);
		await flow.provider.saveTokens({
			access_token: "at-old",
			token_type: "Bearer",
			expires_in: 0,
			refresh_token: "rt-1",
		});

		const promise = flow.authorize();
		await completeBrowserStep(await waitForAuthUrl(events));
		await expect(promise).resolves.toEqual({ status: "authorized" });

		expect(fake.counts.refresh).toBe(1);
		expect(fake.counts.register).toBe(1);
		expect(fake.counts.token).toBe(1);
		expect(prompts).toHaveLength(1);
		expect(flow.provider.tokens()).toMatchObject({ access_token: "at-1" });
	});

	it("maps a failing code exchange to auth_failed after the SDK's single retry", async () => {
		const fake = await startFakeOAuthServer({ tokenError: "invalid_grant" });
		const { interaction, events, prompts } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		await completeBrowserStep(await waitForAuthUrl(events));
		await expect(promise).rejects.toMatchObject({ kind: "auth_failed", mcpKind: "auth_required" });

		expect(fake.counts.token).toBe(2);
		expect(prompts).toHaveLength(1);
	});
});

describe("MCPAuthFlow https callback mode", () => {
	it("uses the fixed https redirect URI and collects the code via a manual-code prompt", async () => {
		const fake = await startFakeOAuthServer({ expectedCode: "manual-code" });
		const { interaction, events, prompts } = createFakeInteraction({ manualCode: "manual-code" });
		const flow = createFlow(fake, interaction, {
			callbackMode: "https",
			httpsCallbackUrl: "https://aos.example.com/callback",
		});

		await expect(flow.authorize()).resolves.toEqual({ status: "authorized" });

		const authUrl = authUrlFrom(events);
		expect(authUrl?.searchParams.get("redirect_uri")).toBe("https://aos.example.com/callback");
		expect(prompts.map((prompt) => prompt.type)).toEqual(["select", "manual_code"]);
		expect(fake.counts.token).toBe(1);
		expect(flow.provider.tokens()).toMatchObject({ access_token: "at-1" });
	});

	it("rejects a non-https callback URL", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction } = createFakeInteraction();
		expect(() =>
			createFlow(fake, interaction, { callbackMode: "https", httpsCallbackUrl: "http://aos.example.com/callback" }),
		).toThrowError(new MCPAuthError("invalid_callback_url", "test-server"));
		expect(() => createFlow(fake, interaction, { callbackMode: "https" })).toThrowError(
			new MCPAuthError("invalid_callback_url", "test-server"),
		);
		expect(() =>
			createFlow(fake, interaction, {
				callbackMode: "https",
				httpsCallbackUrl: "https://aos.example.com/callback?x=1",
			}),
		).toThrowError(new MCPAuthError("invalid_callback_url", "test-server"));
	});
});

describe("MCPAuthFlow server URL validation", () => {
	it("accepts only http(s) endpoints, https unless loopback, without userinfo or credential query", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction } = createFakeInteraction();
		const options = { serverId: "test-server", interaction };
		expect(() => new MCPAuthFlow({ ...options, serverUrl: "ftp://mcp.example.com/mcp" })).toThrowError(
			new MCPAuthError("invalid_server_url", "test-server"),
		);
		expect(() => new MCPAuthFlow({ ...options, serverUrl: "https://mcp.example.com/mcp?api_key=1" })).toThrowError(
			new MCPAuthError("invalid_server_url", "test-server"),
		);
		expect(() => new MCPAuthFlow({ ...options, serverUrl: "https://user@mcp.example.com/mcp" })).toThrowError(
			new MCPAuthError("invalid_server_url", "test-server"),
		);
		expect(() => new MCPAuthFlow({ ...options, serverUrl: "http://mcp.example.com/mcp" })).toThrowError(
			new MCPAuthError("insecure_endpoint", "test-server"),
		);
		expect(() => new MCPAuthFlow({ ...options, serverUrl: fake.url })).not.toThrow();
		expect(() => new MCPAuthFlow({ ...options, serverUrl: "https://mcp.example.com/mcp" })).not.toThrow();
	});
});

describe("MCPAuthFlow discovery", () => {
	it("reports not_required when the server advertises no OAuth at all", async () => {
		const fake = await startFakeOAuthServer({ prm: false, metadata: false });
		const { interaction, events, prompts } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		await expect(flow.authorize()).resolves.toEqual({ status: "not_required" });
		expect(prompts).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	it("supports legacy discovery: no protected resource metadata but AS metadata at the server origin", async () => {
		const fake = await startFakeOAuthServer({ prm: false });
		const { interaction, events } = createFakeInteraction();
		const flow = createFlow(fake, interaction);

		const promise = flow.authorize();
		await completeBrowserStep(await waitForAuthUrl(events));
		await expect(promise).resolves.toEqual({ status: "authorized" });
		expect(fake.counts.metadata).toBeGreaterThan(0);
	});

	it("rejects a protected resource that does not canonically match the server endpoint", async () => {
		const fake = await startFakeOAuthServer({ resource: "https://other.example/mcp" });
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "resource_mismatch",
			mcpKind: "connect_failed",
		});
	});

	it("rejects a PRM authorization server that is not https (non-loopback)", async () => {
		const fake = await startFakeOAuthServer({ authorizationServers: ["http://auth.example.com"] });
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "discovery_failed",
		});
	});

	it("rejects an authorization server metadata issuer that is not canonical", async () => {
		const fake = await startFakeOAuthServer({ metadataOverrides: { issuer: "https://other.example" } });
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "issuer_mismatch",
			mcpKind: "connect_failed",
		});
	});

	it("rejects authorization server endpoints on a different origin", async () => {
		const fake = await startFakeOAuthServer({
			metadataOverrides: { token_endpoint: "https://other.example/token" },
		});
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "issuer_mismatch",
		});
	});

	it("rejects metadata without authorization code response support", async () => {
		const fake = await startFakeOAuthServer({ metadataOverrides: { response_types_supported: ["token"] } });
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "unsupported",
		});
	});

	it("rejects metadata without PKCE S256 support", async () => {
		const fake = await startFakeOAuthServer({
			metadataOverrides: { code_challenge_methods_supported: ["plain"] },
		});
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "unsupported",
		});
	});

	it("fails closed when OAuth is advertised but AS metadata is missing", async () => {
		const fake = await startFakeOAuthServer({ metadata: false });
		await expect(discoverMCPOAuth(fake.url, { serverId: "test-server" })).rejects.toMatchObject({
			kind: "discovery_failed",
		});
	});
});

describe("MCPAuthError classification and redaction", () => {
	it("classifies SDK errors into fixed templates without URLs, tokens, or remote text", async () => {
		const classified = classifyMCPAuthError(new UnauthorizedError("remote detail"), "test-server", "auth");
		expect(classified).toBeInstanceOf(MCPAuthError);
		expect(classified).toMatchObject({ kind: "auth_failed", mcpKind: "auth_required" });
		expect(classifyMCPAuthError(new Error("boom"), "test-server", "discovery")).toMatchObject({
			kind: "discovery_failed",
			mcpKind: "connect_failed",
		});
		expect(classifyMCPAuthError(new Error("boom"), "test-server", "auth")).toMatchObject({ kind: "auth_failed" });

		const timeout = new Error("timed out");
		timeout.name = "TimeoutError";
		expect(classifyMCPAuthError(timeout, "test-server", "discovery")).toMatchObject({ kind: "discovery_failed" });
		expect(classifyMCPAuthError(timeout, "test-server", "auth")).toMatchObject({ kind: "auth_failed" });

		const denied = new Error("user denied");
		(denied as Error & { errorCode?: unknown }).errorCode = "access_denied";
		expect(classifyMCPAuthError(denied, "test-server", "auth")).toMatchObject({ kind: "user_cancelled" });

		const aborted = new DOMException("nope", "AbortError");
		expect(classifyMCPAuthError(aborted, "test-server", "auth")).toBe(aborted);

		for (const message of [classified.message, 'MCP server "test-server" authorization was cancelled']) {
			expect(message).not.toMatch(/https?:\/\//);
			expect(message).not.toMatch(/token|secret|at-1|rt-1/i);
		}
	});

	it("serializes to the redacted MCPErrorView shape", () => {
		const error = new MCPAuthError("callback_timeout", "test-server");
		expect(error.toView()).toEqual({
			kind: "auth_required",
			serverId: "test-server",
			message: 'MCP server "test-server" authorization callback timed out',
			code: "capability_mcp_auth_required",
		});
	});

	it("never leaks the authorization URL or tokens into flow failure messages", async () => {
		const fake = await startFakeOAuthServer();
		const { interaction } = createFakeInteraction({ confirm: "cancel" });
		const flow = createFlow(fake, interaction);
		await expect(flow.authorize()).rejects.toSatisfy((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain(fake.origin);
			expect(message).not.toContain("127.0.0.1");
			expect(message).not.toContain("test-code");
			return true;
		});

		const failed = await startFakeOAuthServer({ stateOverride: "wrong-state" });
		const cancelled = createFakeInteraction();
		const otherFlow = createFlow(failed, cancelled.interaction);
		const promise = otherFlow.authorize();
		const assertion = expect(promise).rejects.toSatisfy((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain(failed.origin);
			expect(message).not.toContain("wrong-state");
			return true;
		});
		await completeBrowserStep(await waitForAuthUrl(cancelled.events));
		await assertion;
	});
});

describe("canonical resource helpers", () => {
	it("canonicalMCPResourceUrl strips query and fragment", () => {
		expect(canonicalMCPResourceUrl("https://mcp.example.com/mcp?transport=streamable-http#frag").toString()).toBe(
			"https://mcp.example.com/mcp",
		);
	});

	it("isCanonicalMCPResourceMatch enforces origin and path prefix", () => {
		const canonical = canonicalMCPResourceUrl("https://mcp.example.com/mcp");
		expect(isCanonicalMCPResourceMatch(canonical, "https://mcp.example.com/mcp")).toBe(true);
		expect(isCanonicalMCPResourceMatch(canonical, "https://mcp.example.com")).toBe(true);
		expect(isCanonicalMCPResourceMatch(canonical, "https://mcp.example.com/api")).toBe(false);
		expect(isCanonicalMCPResourceMatch(canonical, "https://other.example/mcp")).toBe(false);
		expect(isCanonicalMCPResourceMatch(canonical, "http://mcp.example.com/mcp")).toBe(false);
		expect(isCanonicalMCPResourceMatch(canonical, "https://user@mcp.example.com/mcp")).toBe(false);
		expect(isCanonicalMCPResourceMatch(canonical, "not a url")).toBe(false);
		expect(
			isCanonicalMCPResourceMatch(
				canonicalMCPResourceUrl("https://mcp.example.com/api"),
				"https://mcp.example.com/api123",
			),
		).toBe(false);
	});

	it("rejects via the provider adapter when the resource claim mismatches mid-flow", async () => {
		const fake = await startFakeOAuthServer({ resource: "https://other.example/mcp" });
		const { interaction } = createFakeInteraction();
		const flow = createFlow(fake, interaction);
		await expect(flow.authorize()).rejects.toMatchObject({ kind: "resource_mismatch" });
	});
});
