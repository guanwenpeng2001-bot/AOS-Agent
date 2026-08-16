/**
 * Focused tests for the host-side MCP OAuth core (Task B).
 *
 * Everything runs against fake metadata / registration / token endpoints and a
 * fake MCP endpoint; no real server, browser, token, or credential is ever
 * contacted. The SDK discovery and token helpers are exercised through their
 * real implementations with an injected fetch.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type { AuthEvent, AuthInteraction } from "@aos-agent/ai";
import {
	isMCPAuthError,
	MCPAuthError,
	MCPAuthProvider,
	type MCPAuthContext,
	type MCPAuthOptions,
	type MCPAuthRecordBinding,
	type MCPAuthResult,
	type MCPAuthSession,
	type MCPAuthStore,
	type MCPStoredOAuthRecord,
	validateMCPRedirectUrl,
} from "../src/core/mcp-auth.ts";

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

/**
 * Fake OAuth environment: protected resource metadata, authorization server
 * metadata, dynamic registration, token endpoint, and the MCP endpoint.
 * Every request is recorded for assertions.
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

	tokenRequests: Array<{ grant: string | null; params: URLSearchParams; headers: Headers }> = [];
	registrationRequests: Array<{ body: string; headers: Headers }> = [];
	mcpPosts: Array<{ headers: Headers; body: string }> = [];

	fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
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
		// MCP endpoint.
		this.mcpPosts.push({ headers, body: body ?? "" });
		if (this.mcpPosts.length <= this.mcp401Count) {
			return jsonResponse(401, {}, { "www-authenticate": 'Bearer realm="mcp"' });
		}
		return jsonResponse(200, {
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				serverInfo: { name: "fake-mcp", version: "0.0.0" },
			},
		});
	};
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

/** In-memory {@link MCPAuthStore} fake. */
class FakeAuthStore implements MCPAuthStore {
	records = new Map<string, MCPStoredOAuthRecord>();
	reads = 0;
	saves = 0;
	deletes = 0;

	private key(binding: MCPAuthRecordBinding): string {
		return `${binding.serverIdentity}|${binding.serverId}`;
	}

	async read(binding: MCPAuthRecordBinding): Promise<MCPStoredOAuthRecord | undefined> {
		this.reads++;
		return this.records.get(this.key(binding));
	}

	async save(record: MCPStoredOAuthRecord): Promise<void> {
		this.saves++;
		this.records.set(this.key(record), record);
	}

	async delete(binding: MCPAuthRecordBinding): Promise<void> {
		this.deletes++;
		this.records.delete(this.key(binding));
	}
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

function context(overrides: Partial<MCPAuthContext> = {}): MCPAuthContext {
	return {
		serverId: "docs",
		serverIdentity: "settings://global/mcp/docs",
		sessionId: "session-1",
		...overrides,
	};
}

function defaultOptions(overrides: Partial<MCPAuthOptions> = {}): MCPAuthOptions {
	return {
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		...overrides,
	};
}

/** Options bound to a fake environment so no request ever leaves the test. */
function flowOptions(fake: FakeAuthServer, overrides: Partial<MCPAuthOptions> = {}): MCPAuthOptions {
	return {
		serverUrl: SERVER_URL,
		redirectUrl: REDIRECT_URL,
		fetchFn: fake.fetch,
		...overrides,
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

function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function expectAuthError(
	promise: Promise<unknown>,
	kind: MCPAuthError["kind"],
): Promise<MCPAuthError> {
	try {
		await promise;
	} catch (error) {
		expect(isMCPAuthError(error)).toBe(true);
		const authError = error as MCPAuthError;
		expect(authError.kind).toBe(kind);
		expect(authError.serverId).toBe("docs");
		expect(authError.toJSON()).toEqual({
			kind,
			serverId: "docs",
			message: authError.message,
		});
		return authError;
	}
	throw new Error(`expected MCPAuthError ${kind}, but the promise resolved`);
}

/**
 * Runs a full interactive flow: start, wait for the auth_url event, deliver a
 * callback with the flow state, and await the exchange.
 */
async function runInteractiveFlow(
	provider: MCPAuthProvider,
	ctx: MCPAuthContext,
	options: MCPAuthOptions,
	interaction: AuthInteraction & { events: AuthEvent[] },
	code = "auth-code-1",
): Promise<MCPAuthResult> {
	const promise = provider.startInteractive(ctx, options, interaction);
	await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
	const authorizationUrl = authorizationUrlFromInteraction(interaction);
	const state = authorizationUrl.searchParams.get("state");
	if (state === null) {
		throw new Error("authorization URL carries no state");
	}
	await provider.completeAuthorization(ctx, options, code, { state });
	return promise;
}

const sessions: MCPAuthSession[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) {
		void session.close();
	}
});

describe("redirect URL policy", () => {
	it.each([
		["https://app.example/callback", undefined],
		["http://localhost:8765/callback", undefined],
		["http://127.0.0.1:8765/callback", undefined],
		["http://[::1]:8765/callback", undefined],
		["http://127.0.0.1/callback?x=1", undefined],
		["http://example.com/callback", "must use https or an http loopback address"],
		["javascript:alert(1)", "must use https or an http loopback address"],
		["ftp://example.com/callback", "must use https or an http loopback address"],
		["http://user:pass@127.0.0.1/callback", "must not contain userinfo"],
		["not a url", "must be a valid URL"],
	])("validateMCPRedirectUrl(%s)", (url, expected) => {
		expect(validateMCPRedirectUrl(url)).toBe(expected);
	});

	it("fails closed at session creation with a non-loopback http redirect", () => {
		const provider = new MCPAuthProvider();
		expect(() =>
			provider.session(context(), defaultOptions({ redirectUrl: "http://example.com/callback" })),
		).toThrowError(MCPAuthError);
		try {
			provider.session(context(), defaultOptions({ redirectUrl: "http://example.com/callback" }));
		} catch (error) {
			expect((error as MCPAuthError).kind).toBe("mcp_auth_invalid_redirect");
		}
	});

	it("accepts https and loopback redirects at session creation", () => {
		const provider = new MCPAuthProvider();
		for (const redirectUrl of [
			"https://app.example/callback",
			"http://localhost:8765/callback",
			"http://127.0.0.1:8765/callback",
			"http://[::1]:8765/callback",
		]) {
			const session = provider.session(context({ sessionId: `session-${redirectUrl}` }), defaultOptions({ redirectUrl }));
			sessions.push(session);
			expect(session.getStatus().state).toBe("unauthenticated");
		}
	});
});

describe("discovery and metadata validation", () => {
	it("builds a validated authorization URL with state, PKCE S256, and the canonical resource", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const options = flowOptions(fake, { scope: "mcp" });
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, ctx, options, interaction);

		expect(result.outcome).toBe("authorized");
		expect(result.status.state).toBe("authenticated");
		expect(result.status.expiresAt).toBeDefined();

		const authorizationUrl = authorizationUrlFromInteraction(interaction);
		expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizationUrl.searchParams.get("client_id")).toBe("dcr-client-1");
		expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);
		expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
		expect(authorizationUrl.searchParams.get("scope")).toBe("mcp");
		expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.invalid/");
		expect(authorizationUrl.hostname).toBe("as.invalid");

		// PKCE: the exchanged code_verifier must match the code_challenge.
		const exchange = fake.tokenRequests.find((entry) => entry.grant === "authorization_code");
		expect(exchange).toBeDefined();
		const verifier = exchange?.params.get("code_verifier") ?? "";
		expect(pkceChallenge(verifier)).toBe(authorizationUrl.searchParams.get("code_challenge"));
		expect(exchange?.params.get("code")).toBe("auth-code-1");
		expect(exchange?.params.get("redirect_uri")).toBe(REDIRECT_URL);
		expect(exchange?.params.get("client_id")).toBe("dcr-client-1");
		expect(exchange?.params.get("resource")).toBe("https://mcp.invalid/");

		// One dynamic registration, one exchange.
		expect(fake.registrationRequests).toHaveLength(1);
		expect(fake.tokenRequests).toHaveLength(1);
	});

	it("uses a static public client id when configured, without dynamic registration", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, ctx, flowOptions(fake, { clientId: "static-client-1" }), interaction);

		expect(result.outcome).toBe("authorized");
		expect(fake.registrationRequests).toHaveLength(0);
		expect(authorizationUrlFromInteraction(interaction).searchParams.get("client_id")).toBe("static-client-1");
	});

	it("fails closed when the protected resource metadata resource is not secure", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		for (const resource of ["javascript:alert(1)", "http://example.com/", "ftp://example.com/x"]) {
			fake.prm = { ...DEFAULT_PRM, resource };
			await expectAuthError(
				provider.startInteractive(ctx, flowOptions(fake), undefined),
				"mcp_auth_metadata_invalid",
			);
		}
	});

	it("treats schema-invalid protected resource metadata as RFC 9728-unsupported and binds to the server URL", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		// The SDK schema rejects an unparseable resource at discovery, so the
		// server is treated as not supporting RFC 9728: the authorization
		// server falls back to the server origin and the canonical resource is
		// the (still https) server URL.
		fake.prm = { ...DEFAULT_PRM, resource: "not-a-url" };
		fake.asMetadata = { ...DEFAULT_AS_METADATA, issuer: "https://mcp.invalid/" };
		const result = await provider.startInteractive(context(), flowOptions(fake), undefined);
		expect(result.outcome).toBe("interaction_required");
		const authorizationUrl = new URL(result.authorizationUrl ?? "");
		expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.invalid/mcp");
	});

	it("fails closed on insecure authorization_servers and jwks_uri in protected resource metadata", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		fake.prm = { ...DEFAULT_PRM, authorization_servers: ["http://example.com/"] };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.prm = { ...DEFAULT_PRM, jwks_uri: "javascript:alert(1)" };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.prm = { ...DEFAULT_PRM, jwks_uri: "https://as.invalid/jwks" };
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		expect(result.outcome).toBe("authorized");
	});

	it("fails closed when the authorization server issuer does not match its URL", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		fake.asMetadata = { ...DEFAULT_AS_METADATA, issuer: "https://other.invalid/" };
		const error = await expectAuthError(
			provider.startInteractive(context(), flowOptions(fake, ), undefined),
			"mcp_auth_resource_mismatch",
		);
		expect(error.message).toBe(
			'MCP server "docs" OAuth resource or issuer does not match the configured binding',
		);
	});

	it("fails closed on insecure authorization server endpoints", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		fake.asMetadata = { ...DEFAULT_AS_METADATA, authorization_endpoint: "http://example.com/authorize" };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.asMetadata = { ...DEFAULT_AS_METADATA, token_endpoint: "javascript:alert(1)" };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.asMetadata = { ...DEFAULT_AS_METADATA, registration_endpoint: "ftp://example.com/register" };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.asMetadata = { ...DEFAULT_AS_METADATA, revocation_endpoint: "http://example.com/revoke" };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");
	});

	it("fails closed when the authorization server cannot support the required flow", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		fake.asMetadata = { ...DEFAULT_AS_METADATA, code_challenge_methods_supported: ["plain"] };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.asMetadata = { ...DEFAULT_AS_METADATA, response_types_supported: ["token"] };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");

		fake.asMetadata = { ...DEFAULT_AS_METADATA, grant_types_supported: ["client_credentials"] };
		await expectAuthError(provider.startInteractive(ctx, flowOptions(fake, ), undefined), "mcp_auth_metadata_invalid");
	});

	it("fails closed when the server supports neither registration nor a static client", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		fake.asMetadata = { ...DEFAULT_AS_METADATA, registration_endpoint: undefined };
		const error = await expectAuthError(
			provider.startInteractive(context(), flowOptions(fake, ), undefined),
			"mcp_auth_metadata_invalid",
		);
		// No remote text ever reaches the message.
		expect(error.message).not.toContain("registration");
	});
});

describe("canonical resource and issuer binding", () => {
	it("pins the protected resource metadata resource as the canonical resource", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, context(), flowOptions(fake, ), interaction);
		expect(result.outcome).toBe("authorized");
		const authorizationUrl = authorizationUrlFromInteraction(interaction);
		expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.invalid/");
		const exchange = fake.tokenRequests.find((entry) => entry.grant === "authorization_code");
		expect(exchange?.params.get("resource")).toBe("https://mcp.invalid/");
	});

	it("fails closed when the metadata resource conflicts with an explicit canonical resource", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		fake.prm = { ...DEFAULT_PRM, resource: "https://other.invalid/" };
		await expectAuthError(
			provider.startInteractive(ctx, flowOptions(fake, { canonicalResource: "https://mcp.invalid/" }), undefined),
			"mcp_auth_resource_mismatch",
		);
	});

	it("falls back to the server URL as the canonical resource when no protected resource metadata exists", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		fake.prm = undefined;
		// Without a PRM the SDK falls back to the server URL as authorization
		// server, so its metadata must be served there and match the issuer.
		fake.asMetadata = { ...DEFAULT_AS_METADATA, issuer: "https://mcp.invalid/" };
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, context(), flowOptions(fake, ), interaction);
		expect(result.outcome).toBe("authorized");
		const authorizationUrl = authorizationUrlFromInteraction(interaction);
		expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.invalid/mcp");
	});

	it("validates the resource indicator through the SDK provider adapter", async () => {
		const provider = new MCPAuthProvider();
		const session = provider.session(context(), defaultOptions());
		sessions.push(session);
		await session.saveDiscoveryState({
			authorizationServerUrl: AS_URL,
			resourceMetadata: { ...DEFAULT_PRM },
		});
		const adapter = session.createOAuthClientProvider();
		const validateResource = adapter.validateResourceURL;
		if (validateResource === undefined) {
			throw new Error("adapter must implement validateResourceURL");
		}
		const resource = await validateResource(SERVER_URL, "https://mcp.invalid/");
		expect(resource?.toString()).toBe("https://mcp.invalid/");

		// A resource that differs from the pinned canonical one fails closed.
		await expectAuthError(
			validateResource(SERVER_URL, "https://other.invalid/") as Promise<unknown>,
			"mcp_auth_resource_mismatch",
		);

		// An explicit canonical resource that conflicts with the metadata
		// resource fails closed at discovery-save time.
		const session3 = provider.session(
			context({ sessionId: "session-3" }),
			defaultOptions({ canonicalResource: "https://mcp.invalid/" }),
		);
		sessions.push(session3);
		await expectAuthError(
			session3.saveDiscoveryState({
				authorizationServerUrl: AS_URL,
				resourceMetadata: { ...DEFAULT_PRM, resource: "https://other.invalid/" },
			}),
			"mcp_auth_resource_mismatch",
		);
	});
});

describe("state and PKCE: one flow per session and server", () => {
	it("rejects a callback whose state does not match the current flow", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";

		await expectAuthError(
			provider.completeAuthorization(ctx, flowOptions(fake, ), "code-wrong", { state: "wrong-state" }),
			"mcp_auth_state_mismatch",
		);

		// The mismatch is discarded; the flow stays armed and the correct
		// callback still completes it.
		await provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", { state });
		const result = await promise;
		expect(result.outcome).toBe("authorized");
	});

	it("rejects callbacks after the flow completed and rejects redirect mismatches", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		expect(result.outcome).toBe("authorized");
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";
		await expectAuthError(
			provider.completeAuthorization(ctx, flowOptions(fake, ), "code-late", { state }),
			"mcp_auth_state_mismatch",
		);
	});

	it("rejects a callback whose redirect URI does not match the flow", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";
		await expectAuthError(
			provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", {
				state,
				redirectUri: "http://127.0.0.1:9999/other",
			}),
			"mcp_auth_state_mismatch",
		);
		await provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", { state });
		expect((await promise).outcome).toBe("authorized");
	});

	it("keeps flows isolated across sessions: a state from another session is rejected", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctxA = context({ sessionId: "session-a" });
		const ctxB = context({ sessionId: "session-b" });
		const interactionA = makeInteraction();
		const interactionB = makeInteraction();
		const promiseA = provider.startInteractive(ctxA, flowOptions(fake, ), interactionA);
		const promiseB = provider.startInteractive(ctxB, flowOptions(fake, ), interactionB);
		await waitUntil(() => interactionA.events.some((event) => event.type === "auth_url"));
		await waitUntil(() => interactionB.events.some((event) => event.type === "auth_url"));
		const stateB = authorizationUrlFromInteraction(interactionB).searchParams.get("state") ?? "";

		await expectAuthError(
			provider.completeAuthorization(ctxA, flowOptions(fake, ), "code-cross", { state: stateB }),
			"mcp_auth_state_mismatch",
		);

		const stateA = authorizationUrlFromInteraction(interactionA).searchParams.get("state") ?? "";
		await provider.completeAuthorization(ctxA, flowOptions(fake, ), "code-a", { state: stateA });
		await provider.completeAuthorization(ctxB, flowOptions(fake, ), "code-b", { state: stateB });
		expect((await promiseA).outcome).toBe("authorized");
		expect((await promiseB).outcome).toBe("authorized");
	});

	it("joins a concurrent flow on the same session instead of starting a second one", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const first = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		const second = provider.startInteractive(ctx, flowOptions(fake, ), makeInteraction());
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";
		await provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", { state });
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.outcome).toBe("authorized");
		expect(secondResult.outcome).toBe("authorized");
		// Exactly one code exchange happened for both.
		expect(fake.tokenRequests.filter((entry) => entry.grant === "authorization_code")).toHaveLength(1);
	});

	it("isolates state and verifier per session and never shares them", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctxA = context({ sessionId: "session-a" });
		const ctxB = context({ sessionId: "session-b" });
		const interactionA = makeInteraction();
		const interactionB = makeInteraction();
		const promiseA = provider.startInteractive(ctxA, flowOptions(fake, ), interactionA);
		const promiseB = provider.startInteractive(ctxB, flowOptions(fake, ), interactionB);
		await waitUntil(() => interactionA.events.some((event) => event.type === "auth_url"));
		await waitUntil(() => interactionB.events.some((event) => event.type === "auth_url"));
		const urlA = authorizationUrlFromInteraction(interactionA);
		const urlB = authorizationUrlFromInteraction(interactionB);
		expect(urlA.searchParams.get("state")).not.toBe(urlB.searchParams.get("state"));
		const stateA = urlA.searchParams.get("state") ?? "";
		const stateB = urlB.searchParams.get("state") ?? "";
		await provider.completeAuthorization(ctxA, flowOptions(fake, ), "code-a", { state: stateA });
		await provider.completeAuthorization(ctxB, flowOptions(fake, ), "code-b", { state: stateB });
		expect((await promiseA).outcome).toBe("authorized");
		expect((await promiseB).outcome).toBe("authorized");
	});
});

describe("cancellation and timeout", () => {
	it("returns cancelled when the interaction is aborted while waiting for the callback", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const controller = new AbortController();
		const interaction = makeInteraction(controller);
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		controller.abort();
		const result = await promise;
		expect(result.outcome).toBe("cancelled");
		expect(result.status.state).toBe("unauthenticated");
	});

	it("returns cancelled when the session context signal is aborted", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const controller = new AbortController();
		const ctx = context({ signal: controller.signal });
		const interaction = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		controller.abort();
		const result = await promise;
		expect(result.outcome).toBe("cancelled");
	});

	it("throws mcp_auth_cancelled when the context is already aborted", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const controller = new AbortController();
		controller.abort();
		await expectAuthError(
			provider.startInteractive(context({ signal: controller.signal }), flowOptions(fake, ), undefined),
			"mcp_auth_cancelled",
		);
	});

	it("returns timeout when the callback never arrives", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const promise = provider.startInteractive(
			ctx,
			flowOptions(fake, { authorizationTimeoutMs: 60 }),
			interaction,
		);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const result = await promise;
		expect(result.outcome).toBe("timeout");
		expect(result.status.state).toBe("unauthenticated");
	});

	it("throws mcp_auth_timeout when a token request hangs", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = () => new Promise<TokenResponse>(() => {});
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, { requestTimeoutMs: 60 }), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";
		await provider.completeAuthorization(ctx, flowOptions(fake, { requestTimeoutMs: 60 }), "code-1", { state });
		await expectAuthError(promise, "mcp_auth_timeout");
	});
});

describe("headless behavior", () => {
	it("returns the one-time authorization URL without an interaction and completes later", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const result = await provider.startInteractive(ctx, flowOptions(fake, ), undefined);
		expect(result.outcome).toBe("interaction_required");
		expect(result.authorizationUrl).toBeDefined();
		expect(result.status.state).toBe("interaction_required");
		const authorizationUrl = new URL(result.authorizationUrl ?? "");
		const state = authorizationUrl.searchParams.get("state") ?? "";

		await provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", { state });
		const final = await provider.waitForAuthorization(ctx, flowOptions(fake, ));
		expect(final.outcome).toBe("authorized");
		expect(final.status.state).toBe("authenticated");
	});

	it("joins a pending headless flow from a second startInteractive", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const headless = await provider.startInteractive(ctx, flowOptions(fake, ), undefined);
		expect(headless.outcome).toBe("interaction_required");
		const state = new URL(headless.authorizationUrl ?? "").searchParams.get("state") ?? "";

		const second = provider.startInteractive(ctx, flowOptions(fake), undefined);
		await provider.completeAuthorization(ctx, flowOptions(fake), "code-1", { state });
		expect((await second).outcome).toBe("authorized");
		// The flow settled, so there is nothing left pending to await.
		const after = await provider.waitForAuthorization(ctx, flowOptions(fake));
		expect(after.outcome).toBe("interaction_required");
	});
});

describe("refresh and the 401 single-retry contract", () => {
	it("refreshes with the canonical resource and rotates the refresh token", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const token = await provider.getAccessToken(ctx, flowOptions(fake, ));
		expect(token).toBe("at-1");

		const result = await provider.refresh(ctx, flowOptions(fake, ));
		expect(result.outcome).toBe("authorized");
		expect(result.status.state).toBe("authenticated");
		const refresh = fake.tokenRequests.find((entry) => entry.grant === "refresh_token");
		expect(refresh).toBeDefined();
		expect(refresh?.params.get("refresh_token")).toBe("rt-1");
		expect(refresh?.params.get("resource")).toBe("https://mcp.invalid/");
		expect(refresh?.params.get("client_id")).toBe("dcr-client-1");
		const refreshedToken = await provider.getAccessToken(ctx, flowOptions(fake, ));
		expect(refreshedToken).toBe("at-2");
		// Second refresh uses the rotated token.
		await provider.refresh(ctx, flowOptions(fake, ));
		const secondRefresh = fake.tokenRequests.filter((entry) => entry.grant === "refresh_token");
		expect(secondRefresh).toHaveLength(2);
		expect(secondRefresh[1]?.params.get("refresh_token")).toBe("rt-2");
	});

	it("serializes concurrent refreshes into a single token request", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const results = await Promise.all([
			provider.refresh(ctx, flowOptions(fake, )),
			provider.refresh(ctx, flowOptions(fake, )),
			provider.refresh(ctx, flowOptions(fake, )),
		]);
		expect(results.every((entry) => entry.outcome === "authorized")).toBe(true);
		expect(fake.tokenRequests.filter((entry) => entry.grant === "refresh_token")).toHaveLength(1);
	});

	it("reports interaction_required on invalid_grant and clears the tokens", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = (params) => {
			if (params.get("grant_type") === "refresh_token") {
				return { status: 400, body: { error: "invalid_grant", error_description: "revoked" } };
			}
			return defaultTokenHandler(params);
		};
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const result = await provider.refresh(ctx, flowOptions(fake, ));
		expect(result.outcome).toBe("interaction_required");
		expect(result.status.state).toBe("unauthenticated");
		expect(await provider.getAccessToken(ctx, flowOptions(fake, ))).toBeUndefined();
	});

	it("reports interaction_required when there is no refresh token", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = (params) => {
			if (params.get("grant_type") === "authorization_code") {
				return { status: 200, body: { access_token: "at-1", token_type: "Bearer", expires_in: 3600 } };
			}
			return defaultTokenHandler(params);
		};
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const result = await provider.refresh(ctx, flowOptions(fake, ));
		expect(result.outcome).toBe("interaction_required");
	});

	it("maps refresh failures to fixed errors without leaking remote text", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = (params) => {
			if (params.get("grant_type") === "refresh_token") {
				return { status: 500, body: { error: "server_error", error_description: "leak-attempt-refresh" } };
			}
			return defaultTokenHandler(params);
		};
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const error = await expectAuthError(provider.refresh(ctx, flowOptions(fake, )), "mcp_auth_unavailable");
		expect(error.message).not.toContain("leak-attempt-refresh");
		expect(error.message).not.toContain("rt-1");
	});

	it("treats an expired access token as expired without returning it", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = (params) => {
			if (params.get("grant_type") === "authorization_code") {
				return {
					status: 200,
					body: { access_token: "at-1", token_type: "Bearer", expires_in: -10, refresh_token: "rt-1" },
				};
			}
			return defaultTokenHandler(params);
		};
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const result = await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		expect(result.outcome).toBe("authorized");
		const token = await provider.getAccessToken(ctx, flowOptions(fake, ));
		expect(token).toBeUndefined();
		const status = await provider.getStatus(ctx, flowOptions(fake, ));
		expect(status.state).toBe("expired");
	});
});

describe("headless 401 single retry through the real transport", () => {
	it("re-authenticates once via refresh after a 401 and retries the original message", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const session = provider.session(ctx, flowOptions(fake, ));

		fake.mcp401Count = 1;
		const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
			authProvider: session.createOAuthClientProvider(),
			fetch: fake.fetch,
		});
		const initialize = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "mcp-auth-test", version: "0.0.0" },
			},
		};
		await transport.start();
		await transport.send(initialize as never);

		// Exactly one refresh happened for the 401 and the retry carried the new token.
		expect(fake.tokenRequests.filter((entry) => entry.grant === "refresh_token")).toHaveLength(1);
		expect(fake.mcpPosts).toHaveLength(2);
		expect(fake.mcpPosts[0]?.headers.get("authorization")).toBe("Bearer at-1");
		expect(fake.mcpPosts[1]?.headers.get("authorization")).toBe("Bearer at-2");
		await transport.close();
	});

	it("throws UnauthorizedError when auth is required, then completes via finishAuth", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const session = provider.session(ctx, flowOptions(fake, ));
		session.setInteraction(interaction);

		fake.mcp401Count = 1;
		const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
			authProvider: session.createOAuthClientProvider(),
			fetch: fake.fetch,
		});
		const initialize = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "mcp-auth-test", version: "0.0.0" },
			},
		};
		await transport.start();
		await expect(transport.send(initialize as never)).rejects.toThrowError(UnauthorizedError);

		// The authorization URL surfaced through the interaction.
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";

		// The host validates the callback state, then lets the transport finish.
		await session.completeAuthorization("auth-code-1", { state });
		await transport.finishAuth("auth-code-1");
		await transport.send(initialize as never);

		expect(fake.registrationRequests).toHaveLength(1);
		expect(fake.tokenRequests.filter((entry) => entry.grant === "authorization_code")).toHaveLength(1);
		expect(fake.mcpPosts).toHaveLength(2);
		expect(fake.mcpPosts[1]?.headers.get("authorization")).toBe("Bearer at-1");
		await transport.close();
	});
});

describe("credential store injection", () => {
	it("persists records with the full binding and hydrates a new session from the store", async () => {
		const fake = new FakeAuthServer();
		const store = new FakeAuthStore();
		const provider = new MCPAuthProvider({ store });
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);

		expect(store.records.size).toBe(1);
		const record = [...store.records.values()][0];
		if (record === undefined) {
			throw new Error("no stored record");
		}
		expect(record.serverIdentity).toBe(ctx.serverIdentity);
		expect(record.serverId).toBe(ctx.serverId);
		expect(record.canonicalResource).toBe("https://mcp.invalid/");
		expect(record.issuer).toBe(AS_URL);
		expect(record.clientId).toBe("dcr-client-1");
		expect(record.accessToken).toBe("at-1");
		expect(record.refreshToken).toBe("rt-1");
		expect(record.tokenType).toBe("Bearer");
		expect(record.scope).toBe("mcp");
		expect(record.expiresAt).toBeDefined();
		expect(record.updatedAt).toBeGreaterThan(0);

		// A brand-new session for the same server reads the record from the
		// store (no registration, no interactive flow) and refreshes with it.
		const provider2 = new MCPAuthProvider({ store });
		const session2 = provider2.session(ctx, flowOptions(fake, ));
		sessions.push(session2);
		const result = await auth(session2.createOAuthClientProvider(), {
			serverUrl: SERVER_URL,
			fetchFn: fake.fetch,
		});
		expect(result).toBe("AUTHORIZED");
		expect(store.reads).toBeGreaterThan(0);
		expect(fake.registrationRequests).toHaveLength(1);
		const refresh = fake.tokenRequests.find((entry) => entry.grant === "refresh_token");
		expect(refresh?.params.get("refresh_token")).toBe("rt-1");
		expect(store.saves).toBe(2);
	});

	it("rejects and deletes a record whose canonical resource binding changed", async () => {
		const fake = new FakeAuthServer();
		const store = new FakeAuthStore();
		const provider = new MCPAuthProvider({ store });
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		expect(store.records.size).toBe(1);

		// The server now advertises a different resource; the old record must
		// not be reused (no refresh) and is deleted.
		fake.prm = { ...DEFAULT_PRM, resource: "https://mcp.invalid/moved" };
		const provider2 = new MCPAuthProvider({ store });
		const session2 = provider2.session(ctx, flowOptions(fake, ));
		sessions.push(session2);
		const result = await auth(session2.createOAuthClientProvider(), {
			serverUrl: SERVER_URL,
			fetchFn: fake.fetch,
		});
		expect(result).toBe("REDIRECT");
		expect(store.deletes).toBe(1);
		expect(fake.tokenRequests.filter((entry) => entry.grant === "refresh_token")).toHaveLength(0);
	});

	it("hydrates a persisted token for direct access-token reads after discovery", async () => {
		const fake = new FakeAuthServer();
		const store = new FakeAuthStore();
		const provider = new MCPAuthProvider({ store });
		const ctx = context();
		await runInteractiveFlow(provider, ctx, flowOptions(fake), makeInteraction());

		const provider2 = new MCPAuthProvider({ store });
		const token = await provider2.getAccessToken(ctx, flowOptions(fake));
		expect(token).toBe("at-1");
		expect(store.reads).toBeGreaterThan(1);
	});

	it("deletes the persisted record when SDK token invalidation clears credentials", async () => {
		const fake = new FakeAuthServer();
		const store = new FakeAuthStore();
		const provider = new MCPAuthProvider({ store });
		const ctx = context();
		const options = flowOptions(fake);
		await runInteractiveFlow(provider, ctx, options, makeInteraction());
		const session = provider.session(ctx, options);

		await session.invalidateCredentials("all");
		expect(store.records.size).toBe(0);
	});

	it("clears the record on logout and cancels a pending flow", async () => {
		const fake = new FakeAuthServer();
		const store = new FakeAuthStore();
		const provider = new MCPAuthProvider({ store });
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		expect(store.records.size).toBe(1);

		await provider.logout(ctx, flowOptions(fake, ));
		expect(store.records.size).toBe(0);
		expect((await provider.getStatus(ctx, flowOptions(fake, ))).state).toBe("unauthenticated");
		expect(await provider.getAccessToken(ctx, flowOptions(fake, ))).toBeUndefined();

		// A pending flow is cancelled by logout.
		const interaction2 = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction2);
		await waitUntil(() => interaction2.events.some((event) => event.type === "auth_url"));
		await provider.logout(ctx, flowOptions(fake, ));
		const result = await promise;
		expect(result.outcome).toBe("cancelled");
	});
});

describe("fixed redacted errors", () => {
	it("never retains remote text, tokens, or URLs in exchange errors", async () => {
		const fake = new FakeAuthServer();
		fake.tokenHandler = (params) => {
			if (params.get("grant_type") === "authorization_code") {
				return {
					status: 400,
					body: { error: "invalid_grant", error_description: "secret-leak-attempt-xyz" },
				};
			}
			return defaultTokenHandler(params);
		};
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		const promise = provider.startInteractive(ctx, flowOptions(fake, ), interaction);
		await waitUntil(() => interaction.events.some((event) => event.type === "auth_url"));
		const state = authorizationUrlFromInteraction(interaction).searchParams.get("state") ?? "";
		await provider.completeAuthorization(ctx, flowOptions(fake, ), "code-1", { state });
		const error = await expectAuthError(promise, "mcp_auth_invalid");
		expect(error.message).toBe('MCP server "docs" OAuth credentials are invalid or expired');
		expect(error.message).not.toContain("secret-leak-attempt-xyz");
		expect(error.message).not.toContain("code-1");
		expect(error.message).not.toContain("127.0.0.1");
	});

	it("maps malformed metadata to a fixed error without leaking the remote body", async () => {
		const fake = new FakeAuthServer();
		fake.asMetadata = { ...DEFAULT_AS_METADATA, response_types_supported: "not-an-array" } as unknown as Record<
			string,
			unknown
		>;
		const provider = new MCPAuthProvider();
		const error = await expectAuthError(
			provider.startInteractive(context(), flowOptions(fake, ), undefined),
			"mcp_auth_metadata_invalid",
		);
		expect(error.message).toBe('MCP server "docs" exposed invalid OAuth metadata');
		expect(error.message).not.toContain("not-an-array");
	});

	it("status views never contain secrets", async () => {
		const fake = new FakeAuthServer();
		const provider = new MCPAuthProvider();
		const ctx = context();
		const interaction = makeInteraction();
		await runInteractiveFlow(provider, ctx, flowOptions(fake, ), interaction);
		const status = await provider.getStatus(ctx, flowOptions(fake, ));
		expect(JSON.stringify(status)).not.toContain("at-1");
		expect(JSON.stringify(status)).not.toContain("rt-1");
		expect(JSON.stringify(status)).not.toContain("dcr-client-1");
		expect(JSON.stringify(status)).not.toContain("as.invalid");
		expect(JSON.stringify(status)).not.toContain("127.0.0.1");
	});
});
