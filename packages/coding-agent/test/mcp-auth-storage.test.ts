import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AuthStorage,
	ReadOnlyAuthStorage,
} from "../src/core/policy/auth-storage.ts";
import {
	canonicalizeMCPServerUrl,
	deriveMCPServerIdentity,
	getMCPAuthInstallationId,
	isScopeSubset,
	listMCPCredentialStatuses,
	MCPAuthStorage,
	MCPAuthStorageError,
	mcpCredentialKey,
	type MCPStoredTokens,
	type MCPTokenResponse,
} from "../src/core/policy/mcp-auth-storage.ts";

const INSTALLATION_ID = "a".repeat(64);
const SERVER_URL = "https://mcp.example.com/api";
const ISSUER = "https://auth.example.com";
const RESOURCE = "https://mcp.example.com";

function tokenResponse(
	access = "access-token",
	refresh: string | null = "refresh-token",
	extra: Partial<MCPTokenResponse> = {},
): MCPTokenResponse {
	return {
		access_token: access,
		token_type: "Bearer",
		...(refresh !== null ? { refresh_token: refresh } : {}),
		...extra,
	};
}

function createStorage(
	store = AuthStorage.inMemory(),
	serverUrl = SERVER_URL,
	installationId = INSTALLATION_ID,
): MCPAuthStorage {
	return new MCPAuthStorage({ store, installationId, serverUrl });
}

describe("MCP credential namespace keys", () => {
	test("canonicalizes server URLs for identity derivation", () => {
		expect(canonicalizeMCPServerUrl("https://MCP.Example.com/api/")).toBe("https://mcp.example.com/api");
		expect(canonicalizeMCPServerUrl("https://mcp.example.com/api?x=1#frag")).toBe("https://mcp.example.com/api");
		expect(canonicalizeMCPServerUrl("https://user:pass@mcp.example.com/")).toBe("https://mcp.example.com/");
		expect(canonicalizeMCPServerUrl("http://localhost:8080/mcp")).toBe("http://localhost:8080/mcp");
	});

	test("rejects non-http(s) and unparseable server URLs", () => {
		expect(() => canonicalizeMCPServerUrl("ftp://example.com")).toThrow(MCPAuthStorageError);
		expect(() => canonicalizeMCPServerUrl("not a url")).toThrow(MCPAuthStorageError);
		expect(() => canonicalizeMCPServerUrl("https://")).toThrow(MCPAuthStorageError);
	});

	test("derives one identity per canonical server URL and installation", () => {
		const identity = deriveMCPServerIdentity(INSTALLATION_ID, SERVER_URL);
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
		expect(deriveMCPServerIdentity(INSTALLATION_ID, "https://mcp.example.com/api/")).toBe(identity);
		expect(deriveMCPServerIdentity(INSTALLATION_ID, "https://mcp.example.com/other")).not.toBe(identity);
		expect(deriveMCPServerIdentity("b".repeat(64), SERVER_URL)).not.toBe(identity);
	});

	test("builds a namespaced providerId key", () => {
		const identity = deriveMCPServerIdentity(INSTALLATION_ID, SERVER_URL);
		expect(mcpCredentialKey(INSTALLATION_ID, identity)).toBe(`mcp__${INSTALLATION_ID}__${identity}`);
		expect(createStorage().providerId.startsWith(`mcp__${INSTALLATION_ID}__`)).toBe(true);
	});

	test("rejects invalid installation identities and server URLs at construction", () => {
		expect(() => createStorage(AuthStorage.inMemory(), SERVER_URL, "bad id")).toThrow(MCPAuthStorageError);
		expect(() => createStorage(AuthStorage.inMemory(), SERVER_URL, "ab__cd")).toThrow(MCPAuthStorageError);
		expect(() => createStorage(AuthStorage.inMemory(), "ftp://example.com")).toThrow(MCPAuthStorageError);
	});
});

describe("MCPAuthStorage saveTokens", () => {
	test("stores tokens bound to issuer, resource, server identity, and scope", async () => {
		const storage = createStorage();
		const stored = await storage.saveTokens(
			tokenResponse("access-token", "refresh-token", { expires_in: 3600, scope: "tools read" }),
			{ issuer: ISSUER, resource: RESOURCE, requestedScope: "tools read servers" },
		);
		expect(stored).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			tokenType: "Bearer",
			scope: "tools read",
			issuer: ISSUER,
			resource: RESOURCE,
			serverUrl: SERVER_URL,
		});
		expect(stored.expires).toBeGreaterThan(Date.now());
		expect(stored.expires).toBeLessThanOrEqual(Date.now() + 3_700_000);
		expect(await storage.readTokens()).toEqual(stored);
	});

	test("stores an empty refresh token and zero expiry when the server omits them", async () => {
		const storage = createStorage();
		const stored = await storage.saveTokens(tokenResponse("access-token", null), { issuer: ISSUER });
		expect(stored.refresh).toBe("");
		expect(stored.expires).toBe(0);
		expect(await storage.readTokens()).toEqual(stored);
	});

	test("falls back to the requested scope when the response omits scope", async () => {
		const storage = createStorage();
		const stored = await storage.saveTokens(tokenResponse(), {
			issuer: ISSUER,
			requestedScope: "tools read",
		});
		expect(stored.scope).toBe("tools read");
	});

	test("keeps credentials readable by the shared read-only auth.json validation", async () => {
		const tempDir = join(tmpdir(), `aos-test-mcp-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const authPath = join(tempDir, "auth.json");
			const storage = createStorage(AuthStorage.create(authPath));
			await storage.saveTokens(tokenResponse("access-token", "refresh-token", { expires_in: 3600 }), {
				issuer: ISSUER,
			});
			const readOnly = new ReadOnlyAuthStorage(authPath);
			expect(await readOnly.list()).toEqual([{ providerId: storage.providerId, type: "oauth" }]);
			expect(await readOnly.read(storage.providerId)).toEqual(await storage.readTokens());
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects a token response missing access_token or token_type", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens({ access_token: "", token_type: "Bearer" }, { issuer: ISSUER }),
		).rejects.toThrow(MCPAuthStorageError);
		await expect(
			storage.saveTokens({ access_token: "t", token_type: "" }, { issuer: ISSUER }),
		).rejects.toThrow(MCPAuthStorageError);
		await expect(storage.readTokens()).resolves.toBeUndefined();
	});

	test("rejects a non-positive expires_in", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens(tokenResponse("a", "b", { expires_in: -1 }), { issuer: ISSUER }),
		).rejects.toThrow(MCPAuthStorageError);
	});

	test("rejects a granted scope that exceeds the requested scope", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens(tokenResponse("a", "b", { scope: "tools read admin" }), {
				issuer: ISSUER,
				requestedScope: "tools read",
			}),
		).rejects.toThrow(MCPAuthStorageError);
		expect(await storage.readTokens()).toBeUndefined();
	});

	test("rejects scopes with invalid characters", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens(tokenResponse("a", "b", { scope: "tools\u0000read" }), { issuer: ISSUER }),
		).rejects.toThrow(MCPAuthStorageError);
	});

	test("requires an issuer on the first save", async () => {
		const storage = createStorage();
		await expect(storage.saveTokens(tokenResponse())).rejects.toThrow(MCPAuthStorageError);
		expect(await storage.readTokens()).toBeUndefined();
	});

	test("rejects an issuer that is not an http(s) URL", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens(tokenResponse(), { issuer: "auth.example.com" }),
		).rejects.toThrow(MCPAuthStorageError);
	});

	test("rejects replacing tokens with a different issuer", async () => {
		const storage = createStorage();
		await storage.saveTokens(tokenResponse(), { issuer: ISSUER });
		await expect(
			storage.saveTokens(tokenResponse("new", "new-refresh"), { issuer: "https://other.example.com" }),
		).rejects.toThrow(MCPAuthStorageError);
		expect((await storage.readTokens())?.issuer).toBe(ISSUER);
	});

	test("rejects a resource that does not match the server identity", async () => {
		const storage = createStorage();
		await expect(
			storage.saveTokens(tokenResponse(), { issuer: ISSUER, resource: "https://evil.example.com" }),
		).rejects.toThrow(MCPAuthStorageError);
		expect(await storage.readTokens()).toBeUndefined();
	});

	test("rejects replacing tokens with a different resource", async () => {
		const storage = createStorage();
		await storage.saveTokens(tokenResponse(), { issuer: ISSUER, resource: RESOURCE });
		await expect(
			storage.saveTokens(tokenResponse("new"), {
				issuer: ISSUER,
				resource: "https://mcp.example.com/other",
			}),
		).rejects.toThrow(MCPAuthStorageError);
		expect((await storage.readTokens())?.access).toBe("access-token");
	});

	test("rejects a namespace collision with a non-MCP credential", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await store.modify(storage.providerId, async () => ({
			type: "oauth",
			access: "foreign",
			refresh: "foreign-refresh",
			expires: 0,
		}));
		await expect(storage.saveTokens(tokenResponse(), { issuer: ISSUER })).rejects.toThrow(MCPAuthStorageError);
	});

	test("serializes concurrent saves on the same namespace key", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		const [first, second] = await Promise.all([
			storage.saveTokens(tokenResponse("access-v1", "refresh-v1"), { issuer: ISSUER }),
			storage.saveTokens(tokenResponse("access-v2", "refresh-v2"), { issuer: ISSUER }),
		]);
		expect(first.access).toBe("access-v1");
		expect(second.access).toBe("access-v2");
		expect((await storage.readTokens())?.access).toBe("access-v2");
	});
});

describe("MCPAuthStorage readTokens", () => {
	test("resolves undefined when nothing is stored", async () => {
		expect(await createStorage().readTokens()).toBeUndefined();
	});

	test("resolves undefined for a record bound to a different server URL", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await store.modify(storage.providerId, async () => ({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 0,
			tokenType: "Bearer",
			issuer: ISSUER,
			serverUrl: "https://other.example.com",
		}));
		expect(await storage.readTokens()).toBeUndefined();
	});

	test("resolves undefined for a plain OAuth credential under the namespace key", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await store.modify(storage.providerId, async () => ({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 0,
		}));
		expect(await storage.readTokens()).toBeUndefined();
	});

	test("resolves undefined for an ill-formed record (bad issuer)", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await store.modify(storage.providerId, async () => ({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 0,
			tokenType: "Bearer",
			issuer: "not a url",
			serverUrl: SERVER_URL,
		}));
		expect(await storage.readTokens()).toBeUndefined();
	});
});

describe("MCPAuthStorage refreshTokens", () => {
	test("rotates tokens serially under the store lock", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await storage.saveTokens(tokenResponse("access-v1", "refresh-v1", { scope: "tools" }), {
			issuer: ISSUER,
			requestedScope: "tools read",
		});

		const seen: string[] = [];
		const refresh = async (current: MCPStoredTokens): Promise<MCPTokenResponse> => {
			seen.push(current.access);
			await sleep(10);
			const version = seen.length;
			return tokenResponse(`access-v${version + 1}`, `refresh-v${version + 1}`);
		};

		const [first, second] = await Promise.all([
			storage.refreshTokens(refresh),
			storage.refreshTokens(refresh),
		]);

		// Each refresh saw the latest rotation: the second call consumed the
		// token written by the first, never the original.
		expect(seen).toEqual(["access-v1", "access-v2"]);
		expect(first?.access).toBe("access-v2");
		expect(second?.access).toBe("access-v3");
		expect(await storage.readTokens()).toMatchObject({
			access: "access-v3",
			refresh: "refresh-v3",
			scope: "tools",
			issuer: ISSUER,
		});
	});

	test("preserves the refresh token when the response omits a new one", async () => {
		const storage = createStorage();
		await storage.saveTokens(tokenResponse("access-v1", "refresh-v1"), { issuer: ISSUER });
		const rotated = await storage.refreshTokens(async () =>
			tokenResponse("access-v2", null, { expires_in: 60 }),
		);
		expect(rotated).toMatchObject({ access: "access-v2", refresh: "refresh-v1" });
		expect((await storage.readTokens())?.refresh).toBe("refresh-v1");
	});

	test("rejects a scope upgrade during refresh and keeps the stored tokens", async () => {
		const storage = createStorage();
		await storage.saveTokens(tokenResponse("access-v1", "refresh-v1", { scope: "tools" }), {
			issuer: ISSUER,
			requestedScope: "tools read",
		});
		await expect(
			storage.refreshTokens(async () => tokenResponse("access-v2", "refresh-v2", { scope: "tools admin" })),
		).rejects.toThrow(MCPAuthStorageError);
		expect(await storage.readTokens()).toMatchObject({ access: "access-v1", refresh: "refresh-v1" });
	});

	test("resolves undefined without calling the refresher when there is nothing to refresh", async () => {
		const storage = createStorage();
		const refresh = vi.fn(async () => tokenResponse());
		expect(await storage.refreshTokens(refresh)).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();

		await storage.saveTokens(tokenResponse("a", null), { issuer: ISSUER });
		expect(await storage.refreshTokens(refresh)).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
	});

	test("propagates refresher failures and leaves the stored tokens intact", async () => {
		const storage = createStorage();
		await storage.saveTokens(tokenResponse("access-v1", "refresh-v1"), { issuer: ISSUER });
		await expect(
			storage.refreshTokens(async () => {
				throw new Error("invalid_grant");
			}),
		).rejects.toThrow("invalid_grant");
		expect(await storage.readTokens()).toMatchObject({ access: "access-v1", refresh: "refresh-v1" });
	});

	test("refreshes through a file-backed store so another instance sees the rotation", async () => {
		const tempDir = join(tmpdir(), `aos-test-mcp-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const authPath = join(tempDir, "auth.json");
			await createStorage(AuthStorage.create(authPath)).saveTokens(
				tokenResponse("access-v1", "refresh-v1"),
				{ issuer: ISSUER },
			);
			const second = createStorage(AuthStorage.create(authPath));
			const rotated = await second.refreshTokens(async () => tokenResponse("access-v2", "refresh-v2"));
			expect(rotated?.access).toBe("access-v2");
			expect(await createStorage(AuthStorage.create(authPath)).readTokens()).toMatchObject({
				access: "access-v2",
				refresh: "refresh-v2",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("MCPAuthStorage logout and deletion", () => {
	test("revokes best effort and always deletes the local credential", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await storage.saveTokens(tokenResponse("access-token", "refresh-token"), { issuer: ISSUER });

		const revoke = vi.fn(async () => {
			throw new Error("revocation endpoint unavailable");
		});
		await storage.logout(revoke);

		expect(revoke).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ access: "access-token" }));
		expect(await storage.readTokens()).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	test("skips revocation when there is nothing stored and deletes nothing else", async () => {
		const store = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "provider-key" } });
		const storage = createStorage(store);
		const revoke = vi.fn(async () => {});
		await storage.logout(revoke);
		expect(revoke).not.toHaveBeenCalled();
		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
	});

	test("deleteTokens removes only the namespaced credential", async () => {
		const store = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "provider-key" } });
		const storage = createStorage(store);
		await storage.saveTokens(tokenResponse(), { issuer: ISSUER });
		await storage.deleteTokens();
		expect(await storage.readTokens()).toBeUndefined();
		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
	});
});

describe("listMCPCredentialStatuses", () => {
	test("surfaces only masked status, never token values", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await storage.saveTokens(
			tokenResponse("access-token", "refresh-token", { expires_in: 3600, scope: "tools read", id_token: "id" }),
			{ issuer: ISSUER, resource: RESOURCE, requestedScope: "tools read" },
		);

		const statuses = await listMCPCredentialStatuses(store, INSTALLATION_ID);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({
			serverIdentity: storage.providerId.slice(`mcp__${INSTALLATION_ID}__`.length),
			status: "authenticated",
		});
		const json = JSON.stringify(statuses);
		expect(json).not.toContain("access-token");
		expect(json).not.toContain("refresh-token");
		expect(json).not.toContain(SERVER_URL);
		expect(json).not.toContain(ISSUER);
		expect(json).not.toContain(RESOURCE);
		expect(json).not.toContain('"id"');
	});

	test("reports expired when the stored grant has elapsed", async () => {
		const store = AuthStorage.inMemory();
		const storage = createStorage(store);
		await storage.saveTokens(tokenResponse("access-token", null, { expires_in: 3600 }), { issuer: ISSUER });
		await store.modify(storage.providerId, async (current) =>
			current === undefined || current.type !== "oauth" ? current : { ...current, expires: Date.now() - 1 },
		);
		const [status] = await listMCPCredentialStatuses(store, INSTALLATION_ID);
		expect(status?.status).toBe("expired");
		expect(status).not.toHaveProperty("serverUrl");
		expect(status).not.toHaveProperty("issuer");
	});

	test("is scoped to the installation and skips foreign and ill-formed entries", async () => {
		const store = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "provider-key" } });
		const ours = createStorage(store);
		await ours.saveTokens(tokenResponse("ours"), { issuer: ISSUER });

		const otherInstallation = "b".repeat(64);
		const theirs = createStorage(store, SERVER_URL, otherInstallation);
		await theirs.saveTokens(tokenResponse("theirs"), { issuer: ISSUER });

		// An ill-formed MCP-shaped record under our namespace must be skipped.
		await store.modify(mcpCredentialKey(INSTALLATION_ID, "c".repeat(64)), async () => ({
			type: "oauth",
			access: "bad",
			refresh: "bad",
			expires: 0,
			tokenType: "Bearer",
			issuer: "not a url",
			serverUrl: SERVER_URL,
		}));

		const statuses = await listMCPCredentialStatuses(store, INSTALLATION_ID);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.status).toBe("authenticated");
		expect(JSON.stringify(statuses)).not.toContain(SERVER_URL);
		expect(JSON.stringify(statuses)).not.toContain(ISSUER);
		expect(JSON.stringify(statuses)).not.toContain("theirs");
		expect(JSON.stringify(statuses)).not.toContain("provider-key");
	});

	test("rejects an invalid installation identity", async () => {
		await expect(listMCPCredentialStatuses(AuthStorage.inMemory(), "bad id")).rejects.toThrow(
			MCPAuthStorageError,
		);
	});
});

describe("getMCPAuthInstallationId", () => {
	const tempDir = join(tmpdir(), `aos-test-mcp-installation-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("is stable per agentDir, distinct across agentDirs, and a valid namespace segment", () => {
		const first = getMCPAuthInstallationId(tempDir);
		const again = getMCPAuthInstallationId(tempDir);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(again).toBe(first);

		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		expect(getMCPAuthInstallationId(otherDir)).not.toBe(first);
	});
});

describe("isScopeSubset", () => {
	test("checks space-separated scope tokens", () => {
		expect(isScopeSubset("tools read", "tools read servers")).toBe(true);
		expect(isScopeSubset("tools admin", "tools read")).toBe(false);
		expect(isScopeSubset("tools  read", "tools read")).toBe(true);
		expect(isScopeSubset(undefined, "tools")).toBe(true);
		expect(isScopeSubset("tools", undefined)).toBe(true);
		expect(isScopeSubset(undefined, undefined)).toBe(true);
	});
});
