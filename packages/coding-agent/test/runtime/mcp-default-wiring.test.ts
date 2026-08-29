/**
 * Regression tests for the default MCP OAuth session wiring (G3a).
 *
 * Covers:
 * - createAgentSessionServices defaults mcpAuthManagerOptions to the shared
 *   agent auth namespace (AuthStorage on agentDir/auth.json) and passes
 *   explicit mcpAuthProvider/mcpAuthManagerOptions through unchanged.
 * - Sessions built from services own a session-scoped MCPAuthManager backed
 *   by that store; two sessions never share a manager instance.
 * - An explicit store is honored end to end (listMcpCredentialStatuses reads
 *   the supplied store, not the default file).
 * - stdio server configs never receive an OAuth provider; streamable-http
 *   configs do.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFakeProvider } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type AgentSessionServices,
} from "../../src/core/session/services.ts";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { createDefaultMCPAuthManagerOptions } from "../../src/core/policy/mcp-auth-manager.ts";
import { MCPAuthStorage } from "../../src/core/policy/mcp-auth-storage.ts";
import { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import { SessionManager } from "../../src/core/session/manager.ts";

const HTTP_SERVER_URL = "https://mcp.example.invalid/mcp";
const ISSUER_URL = "https://issuer.example.invalid";

describe("MCP OAuth default session wiring", () => {
	const cleanups: Array<() => void> = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function newAgentDir(): string {
		const agentDir = join(tmpdir(), `aos-mcp-default-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		return agentDir;
	}

	async function createFakeRuntime(agentDir: string, authStorage: AuthStorage): Promise<ModelRuntime> {
		const fake = registerFakeProvider({ models: [{ id: "fake-1", reasoning: false }] });
		await authStorage.modify(fake.getModel().provider, async () => ({ type: "api_key", key: "fake-key" }));
		cleanups.push(() => fake.unregister());
		return ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
	}

	async function createServices(
		agentDir: string,
		modelRuntime: ModelRuntime,
		options: Omit<Parameters<typeof createAgentSessionServices>[0], "cwd"> = {},
	): Promise<AgentSessionServices> {
		return createAgentSessionServices({
			...options,
			cwd: agentDir,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
			},
		});
	}

	it("defaults mcpAuthManagerOptions to the agent auth namespace store and passes options through", async () => {
		const agentDir = newAgentDir();
		const modelRuntime = await createFakeRuntime(agentDir, AuthStorage.create(join(agentDir, "auth.json")));
		const authProvider = (): undefined => undefined;

		const services = await createServices(agentDir, modelRuntime, { mcpAuthProvider: authProvider });

		expect(services.mcpAuthManagerOptions).toBeDefined();
		expect(services.mcpAuthManagerOptions?.store).toBeInstanceOf(AuthStorage);
		expect(services.mcpAuthManagerOptions?.installationId).toBe(createDefaultMCPAuthManagerOptions(agentDir).installationId);
		expect(services.mcpAuthProvider).toBe(authProvider);
		expect(services.diagnostics.every((entry) => entry.type !== "error")).toBe(true);
	});

	it("honors explicit mcpAuthManagerOptions instead of the default store", async () => {
		const agentDir = newAgentDir();
		const modelRuntime = await createFakeRuntime(agentDir, AuthStorage.create(join(agentDir, "auth.json")));
		const explicit = {
			store: AuthStorage.inMemory(),
			installationId: "explicit-install",
		};

		const services = await createServices(agentDir, modelRuntime, { mcpAuthManagerOptions: explicit });

		expect(services.mcpAuthManagerOptions).toBe(explicit);
	});

	it("builds a session-scoped manager per session backed by the default store", async () => {
		const agentDir = newAgentDir();
		const modelRuntime = await createFakeRuntime(agentDir, AuthStorage.create(join(agentDir, "auth.json")));
		const services = await createServices(agentDir, modelRuntime);

		const sessionManagerA = SessionManager.inMemory(agentDir);
		const sessionManagerB = SessionManager.inMemory(agentDir);
		const createdA = await createAgentSessionFromServices({ services, sessionManager: sessionManagerA });
		const createdB = await createAgentSessionFromServices({ services, sessionManager: sessionManagerB });
		cleanups.push(() => createdA.session.dispose());
		cleanups.push(() => createdB.session.dispose());

		const managerA = createdA.session.getMcpAuthManager();
		const managerB = createdB.session.getMcpAuthManager();
		expect(managerA).toBeDefined();
		expect(managerB).toBeDefined();
		expect(managerA).not.toBe(managerB);

		// stdio configs never receive an OAuth provider; streamable-http do.
		expect(managerA?.getProvider({ id: "local", transport: "stdio", command: "node" })).toBeUndefined();
		expect(managerA?.getProvider({ id: "docs", transport: "streamable-http", url: HTTP_SERVER_URL })).toBeDefined();
	});

	it("listMcpCredentialStatuses reads the explicitly supplied store and never surfaces tokens", async () => {
		const agentDir = newAgentDir();
		const modelRuntime = await createFakeRuntime(agentDir, AuthStorage.create(join(agentDir, "auth.json")));
		const explicit = {
			store: AuthStorage.inMemory(),
			installationId: "explicit-install",
		};
		const services = await createServices(agentDir, modelRuntime, { mcpAuthManagerOptions: explicit });
		const sessionManager = SessionManager.inMemory(agentDir);
		const created = await createAgentSessionFromServices({ services, sessionManager });
		cleanups.push(() => created.session.dispose());

		const storage = new MCPAuthStorage({
			store: explicit.store,
			installationId: explicit.installationId,
			serverUrl: HTTP_SERVER_URL,
		});
		await storage.saveTokens(
			{ access_token: "access-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-secret" },
			{ issuer: ISSUER_URL, resource: HTTP_SERVER_URL },
		);

		const statuses = await created.session.listMcpCredentialStatuses();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.status).toBe("authenticated");
		expect(statuses[0]?.serverIdentity).toMatch(/^[0-9a-f]{64}$/);
		const serialized = JSON.stringify(statuses);
		expect(serialized).not.toContain("access-secret");
		expect(serialized).not.toContain("refresh-secret");
		expect(serialized).not.toContain(HTTP_SERVER_URL);
		expect(serialized).not.toContain(ISSUER_URL);
	});
});
