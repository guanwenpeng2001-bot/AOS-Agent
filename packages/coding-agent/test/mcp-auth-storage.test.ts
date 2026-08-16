import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@aos-agent/ai";
import { afterAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	MCPAuthStorageError,
	MCPCredentialNamespace,
	listMCPCredentialEntries,
	parseMCPStorageKey,
	type MCPCredentialBinding,
	type MCPCredentialRecord,
	type MCPCredentialScope,
} from "../src/core/mcp-auth-storage.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "aos-mcp-auth-storage-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

function makeScope(overrides: Partial<MCPCredentialScope> = {}): MCPCredentialScope {
	return {
		sourceId: "global",
		serverId: "files",
		serverIdentity: "https://mcp.example.test/files",
		...overrides,
	};
}

function makeBinding(overrides: Partial<MCPCredentialBinding> = {}): MCPCredentialBinding {
	return {
		issuer: "https://auth.example.test",
		resource: "https://mcp.example.test/files",
		scopes: ["files.read", "files.write"],
		clientId: "aos-client",
		...overrides,
	};
}

function makeTokens(overrides: { access?: string; refresh?: string; expires?: number } = {}): {
	access: string;
	refresh?: string;
	expires?: number;
} {
	return {
		access: "access-token-1",
		refresh: "refresh-token-1",
		expires: 2_000_000,
		...overrides,
	};
}

describe("MCPCredentialNamespace storage keys", () => {
	it("computes the mcp-prefixed storage key from source id and server id", () => {
		const namespace = new MCPCredentialNamespace(AuthStorage.inMemory());
		expect(namespace.storageKey(makeScope())).toBe("mcp:global:files");
		expect(namespace.storageKey(makeScope({ sourceId: "project", serverId: "db" }))).toBe("mcp:project:db");
	});

	it("rejects scope segments that would make the namespace ambiguous", () => {
		const namespace = new MCPCredentialNamespace(AuthStorage.inMemory());
		for (const scope of [
			makeScope({ sourceId: "" }),
			makeScope({ sourceId: "global:evil" }),
			makeScope({ sourceId: "glob al" }),
			makeScope({ serverId: "" }),
			makeScope({ serverId: "a:b" }),
			makeScope({ serverId: "a__b" }),
		]) {
			expect(() => namespace.storageKey(scope)).toThrowError(MCPAuthStorageError);
			try {
				namespace.storageKey(scope);
			} catch (error) {
				expect(error).toMatchObject({ code: "mcp_auth_storage_invalid_scope" });
			}
		}
	});

	it("parses mcp storage keys and ignores everything else", () => {
		expect(parseMCPStorageKey("mcp:global:files")).toEqual({ sourceId: "global", serverId: "files" });
		expect(parseMCPStorageKey("mcp:project:db")).toEqual({ sourceId: "project", serverId: "db" });
		expect(parseMCPStorageKey("anthropic")).toBeUndefined();
		expect(parseMCPStorageKey("mcp:")).toBeUndefined();
		expect(parseMCPStorageKey("mcp:global")).toBeUndefined();
		expect(parseMCPStorageKey("mcp:a:b:c")).toBeUndefined();
	});
});

describe("MCPCredentialNamespace save/read", () => {
	it("round-trips a credential with its binding and a monotonic revision", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();

		expect(await namespace.read(scope, binding)).toBeUndefined();

		const saved = await namespace.save(scope, binding, makeTokens());
		expect(saved).toMatchObject({
			type: "oauth",
			access: "access-token-1",
			refresh: "refresh-token-1",
			expires: 2_000_000,
			serverIdentity: scope.serverIdentity,
			issuer: binding.issuer,
			resource: binding.resource,
			scopes: binding.scopes,
			clientId: "aos-client",
			revision: 1,
		});

		const record = await namespace.read(scope, binding);
		expect(record).toEqual(saved);

		// A second save over the same binding bumps the revision.
		const second = await namespace.save(scope, binding, makeTokens({ access: "access-token-2" }));
		expect(second.revision).toBe(2);
		expect((await namespace.read(scope, binding))?.access).toBe("access-token-2");
	});

	it("rejects reads whose binding does not match the stored record", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		const mismatches: Array<Partial<MCPCredentialBinding>> = [
			{ issuer: "https://other-auth.example.test" },
			{ resource: "https://other.example.test/res" },
			{ scopes: ["files.read"] },
			{ clientId: "other-client" },
		];
		for (const mismatch of mismatches) {
			await expect(namespace.read(scope, makeBinding(mismatch))).rejects.toMatchObject({
				code: "mcp_auth_binding_mismatch",
			});
		}
		// The server identity lives on the scope: a different server identity cannot read the record.
		await expect(
			namespace.read(makeScope({ serverIdentity: "https://other.example.test/files" }), makeBinding()),
		).rejects.toMatchObject({ code: "mcp_auth_binding_mismatch" });
	});

	it("rejects saving over a record bound to a different binding", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		await expect(namespace.save(scope, makeBinding({ issuer: "https://new-issuer.example.test" }), makeTokens())).rejects
			.toMatchObject({ code: "mcp_auth_binding_mismatch" });
		// The stale record survives; the caller must logout before re-login under a new binding.
		expect((await namespace.read(scope, makeBinding()))?.access).toBe("access-token-1");
	});

	it("rejects empty access tokens and empty binding fields", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();

		await expect(namespace.save(scope, makeBinding(), makeTokens({ access: "" }))).rejects.toThrow();
		await expect(namespace.save(scope, makeBinding({ issuer: "" }), makeTokens())).rejects.toThrow();
		await expect(
			namespace.read(makeScope({ serverIdentity: "" }), makeBinding()),
		).rejects.toThrow();
	});
});

describe("MCPCredentialNamespace refresh rotation", () => {
	it("rotates tokens inside the serialized modify and bumps the revision", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		const refreshed = await namespace.refresh(scope, binding, async (current) => {
			expect(current.access).toBe("access-token-1");
			expect(current.revision).toBe(1);
			return { access: "access-token-refreshed", refresh: "refresh-token-rotated", expires: 3_000_000 };
		});

		expect(refreshed).toMatchObject({
			access: "access-token-refreshed",
			refresh: "refresh-token-rotated",
			expires: 3_000_000,
			revision: 2,
			issuer: binding.issuer,
			resource: binding.resource,
			serverIdentity: scope.serverIdentity,
		});
		expect((await namespace.read(scope, binding))?.access).toBe("access-token-refreshed");
	});

	it("keeps the stored binding when the refresh omits optional fields", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		const refreshed = await namespace.refresh(scope, binding, async () => ({ access: "new-access" }));
		expect(refreshed).toMatchObject({ access: "new-access", refresh: "refresh-token-1", expires: 2_000_000 });
	});

	it("fails with mcp_auth_not_found when no record exists", async () => {
		const namespace = new MCPCredentialNamespace(AuthStorage.inMemory());
		await expect(
			namespace.refresh(makeScope(), makeBinding(), async () => ({ access: "x" })),
		).rejects.toMatchObject({ code: "mcp_auth_not_found" });
	});

	it("rejects refresh when the binding does not match", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		await expect(
			namespace.refresh(scope, makeBinding({ resource: "https://other.example.test/res" }), async () => ({
				access: "x",
			})),
		).rejects.toMatchObject({ code: "mcp_auth_binding_mismatch" });
		expect((await namespace.read(scope, makeBinding()))?.access).toBe("access-token-1");
	});

	it("serializes concurrent refreshes so a stale result cannot overwrite a newer record", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		const seen: Array<{ access: string; revision: number }> = [];
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = namespace.refresh(scope, binding, async (current) => {
			seen.push({ access: current.access, revision: current.revision });
			await gate;
			return { access: "access-after-first-refresh", refresh: "refresh-after-first" };
		});

		// Wait until the first refresh holds the serialized modify, then start the second.
		while (seen.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const second = namespace.refresh(scope, binding, async (current) => {
			seen.push({ access: current.access, revision: current.revision });
			return { access: "access-after-second-refresh", refresh: "refresh-after-second" };
		});

		// The second refresh must not run while the first holds the lock.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual([{ access: "access-token-1", revision: 1 }]);

		releaseFirst?.();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		// The second refresh observed the first rotation and wrote a newer revision.
		expect(seen).toEqual([
			{ access: "access-token-1", revision: 1 },
			{ access: "access-after-first-refresh", revision: 2 },
		]);
		expect(firstResult.revision).toBe(2);
		expect(secondResult).toMatchObject({ access: "access-after-second-refresh", revision: 3 });

		const final = await namespace.read(scope, binding);
		expect(final?.access).toBe("access-after-second-refresh");
		expect(final?.refresh).toBe("refresh-after-second");
		expect(final?.revision).toBe(3);
	});

	it("leaves the stored record unchanged when the refresh fails and allows a retry", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		let fail = true;
		const refreshTokens = async (): Promise<{ access: string }> => {
			if (fail) {
				fail = false;
				throw new Error("token endpoint unavailable");
			}
			return { access: "access-after-retry" };
		};

		await expect(namespace.refresh(scope, binding, refreshTokens)).rejects.toThrow("token endpoint unavailable");
		expect((await namespace.read(scope, binding))?.access).toBe("access-token-1");

		const retried = await namespace.refresh(scope, binding, refreshTokens);
		expect(retried.access).toBe("access-after-retry");
		expect(retried.revision).toBe(2);
	});

	it("propagates cancellation without touching the stored record", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		const controller = new AbortController();
		controller.abort();
		await expect(namespace.refresh(scope, binding, async () => ({ access: "x" }), { signal: controller.signal }))
			.rejects.toMatchObject({ name: "AbortError" });
		expect((await namespace.read(scope, binding))?.access).toBe("access-token-1");
	});
});

describe("MCPCredentialNamespace logout", () => {
	it("deletes the local record on logout", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		expect(await namespace.logout(scope, binding)).toBe(true);
		expect(await namespace.read(scope, binding)).toBeUndefined();
		expect(await namespace.status(scope)).toMatchObject({ hasCredential: false, status: "none" });
	});

	it("is a no-op when no record exists", async () => {
		const namespace = new MCPCredentialNamespace(AuthStorage.inMemory());
		expect(await namespace.logout(makeScope(), makeBinding())).toBe(false);
	});

	it("rejects logout on binding mismatch and keeps the record", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		await expect(namespace.logout(scope, makeBinding({ issuer: "https://other.example.test" }))).rejects.toMatchObject({
			code: "mcp_auth_binding_mismatch",
		});
		expect((await namespace.read(scope, binding))?.access).toBe("access-token-1");
	});

	it("revokes best-effort before deletion and never blocks on revoke failure", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		await namespace.save(scope, binding, makeTokens());

		const revoked: MCPCredentialRecord[] = [];
		const revoke = async (record: MCPCredentialRecord): Promise<void> => {
			revoked.push(record);
			throw new Error("revocation endpoint unavailable");
		};

		expect(await namespace.logout(scope, binding, { revoke })).toBe(true);
		expect(revoked).toHaveLength(1);
		expect(revoked[0].access).toBe("access-token-1");
		expect(await namespace.read(scope, binding)).toBeUndefined();
	});
});

describe("MCPCredentialNamespace status and views", () => {
	it("reports none / authenticated / expired without any secret", async () => {
		let now = 1_000_000;
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage, () => now);
		const scope = makeScope();
		const binding = makeBinding();

		expect(await namespace.status(scope)).toEqual({
			serverId: "files",
			hasCredential: false,
			status: "none",
			expiresAt: 0,
			scopes: [],
			revision: 0,
		});

		await namespace.save(scope, binding, makeTokens({ expires: 2_000_000 }));
		const view = await namespace.status(scope, binding);
		expect(view).toEqual({
			serverId: "files",
			hasCredential: true,
			status: "authenticated",
			expiresAt: 2_000_000,
			scopes: ["files.read", "files.write"],
			clientId: "aos-client",
			revision: 1,
		});
		// The view carries no token material.
		expect(JSON.stringify(view)).not.toContain("access-token");
		expect(JSON.stringify(view)).not.toContain("refresh-token");

		now = 3_000_000;
		expect((await namespace.status(scope)).status).toBe("expired");

		// Unknown expiry is treated as authenticated (refresh on 401 decides).
		await namespace.save(scope, binding, makeTokens({ expires: 0 }));
		expect((await namespace.status(scope)).status).toBe("authenticated");
	});

	it("verifies the binding when status is asked with one", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		await expect(namespace.status(scope, makeBinding({ scopes: ["other.scope"] }))).rejects.toMatchObject({
			code: "mcp_auth_binding_mismatch",
		});
	});

	it("lists only MCP entries with secret-free views and ignores model credentials", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		await namespace.save(makeScope({ serverId: "files" }), makeBinding(), makeTokens({ access: "files-access" }));
		await namespace.save(
			makeScope({ sourceId: "project", serverId: "db" }),
			makeBinding({ scopes: ["db.read"] }),
			makeTokens({ access: "db-access" }),
		);
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "model-key" }));

		const views = await namespace.list();
		expect(views.map((view) => view.serverId).sort()).toEqual(["db", "files"]);
		expect(JSON.stringify(views)).not.toContain("files-access");
		expect(JSON.stringify(views)).not.toContain("db-access");
		expect(JSON.stringify(views)).not.toContain("model-key");

		const entries = await listMCPCredentialEntries(storage);
		expect(entries.map((entry) => entry.providerId).sort()).toEqual(["mcp:global:files", "mcp:project:db"]);
	});
});

describe("MCPCredentialNamespace isolation from ModelRuntime", () => {
	it("keeps MCP credentials out of model provider enumeration", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		const models = createModels({ credentials: storage });

		// The mcp key is not a provider id in the generated catalog.
		expect(models.getProviders().some((provider) => provider.id === "mcp:global:files")).toBe(false);
		// Model auth checks keyed by provider id never reach the MCP record.
		await expect(models.checkAuth("mcp:global:files")).resolves.toBeUndefined();
		// Model provider reads of the shared store cannot see the MCP record.
		expect(await storage.read("anthropic")).toBeUndefined();
		// The only entry in the shared store is the mcp-prefixed one.
		expect((await storage.list()).map((entry) => entry.providerId)).toEqual(["mcp:global:files"]);
	});
});

describe("MCPCredentialNamespace persistence and fail-closed parsing", () => {
	it("persists records through the file-backed store and reloads them", async () => {
		const dir = mkdtempSync(join(tempRoot, "file-backed-"));
		const authPath = join(dir, "auth.json");
		try {
			const scope = makeScope();
			const binding = makeBinding();
			const namespace = new MCPCredentialNamespace(AuthStorage.create(authPath));
			await namespace.save(scope, binding, makeTokens());

			const persisted = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
			expect(Object.keys(persisted)).toEqual(["mcp:global:files"]);
			expect(persisted["mcp:global:files"]).toMatchObject({
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				issuer: binding.issuer,
				revision: 1,
			});

			const reloaded = new MCPCredentialNamespace(AuthStorage.create(authPath));
			expect((await reloaded.read(scope, binding))?.access).toBe("access-token-1");
			expect(await reloaded.logout(scope, binding)).toBe(true);
			expect(await reloaded.read(scope, binding)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed on malformed records under an mcp key", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		const binding = makeBinding();
		const key = "mcp:global:files";

		// An api_key record must never be an MCP credential.
		await storage.modify(key, async () => ({ type: "api_key", key: "not-an-oauth-record" }));
		await expect(namespace.read(scope, binding)).rejects.toMatchObject({ code: "mcp_auth_storage_invalid_record" });

		// An oauth record without the MCP binding fields is rejected as well.
		await storage.modify(
			key,
			async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1_000_000 }) as never,
		);
		await expect(namespace.status(scope)).rejects.toMatchObject({ code: "mcp_auth_storage_invalid_record" });
		await expect(namespace.list()).rejects.toMatchObject({ code: "mcp_auth_storage_invalid_record" });
		await expect(namespace.logout(scope, binding)).rejects.toMatchObject({ code: "mcp_auth_storage_invalid_record" });
	});

	it("keeps raw secrets and URIs out of errors", async () => {
		const storage = AuthStorage.inMemory();
		const namespace = new MCPCredentialNamespace(storage);
		const scope = makeScope();
		await namespace.save(scope, makeBinding(), makeTokens());

		try {
			await namespace.read(scope, makeBinding({ issuer: "https://evil.example.test/issuer" }));
			throw new Error("expected binding mismatch");
		} catch (error) {
			expect(error).toBeInstanceOf(MCPAuthStorageError);
			expect(error).toMatchObject({ code: "mcp_auth_binding_mismatch", serverId: "files" });
			const serialized = JSON.stringify(error);
			expect(serialized).not.toContain("access-token");
			expect(serialized).not.toContain("refresh-token");
			expect(serialized).not.toContain("evil.example.test");
			expect(serialized).not.toContain("mcp.example.test");
			expect(serialized).not.toContain("auth.example.test");
		}
	});
});
