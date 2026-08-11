import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
} from "@aos-agent/ai/compat";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Server } from "@modelcontextprotocol/sdk/server";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { assertSnapshotMetadataOnly } from "../src/core/context-engine.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { ExtensionFactory, ToolDefinition } from "../src/core/extensions/index.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `pi-capabilities-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { dir, agentDir };
}

function sdkTool(name: string) {
	return {
		name,
		label: name,
		description: `SDK tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	};
}

function skill(name: string): Skill {
	return {
		name,
		description: `description for ${name}`,
		filePath: join(tmpdir(), `skill-${name}`),
		baseDir: join(tmpdir(), `skill-${name}`),
		sourceInfo: createSyntheticSourceInfo(`<skill:${name}>`, { source: "skill" }),
		disableModelInvocation: false,
	};
}

function loaderWithSkills(skills: Skill[]): ResourceLoader {
	const base = createTestResourceLoader();
	return { ...base, getSkills: () => ({ skills, diagnostics: [] }) };
}

function sdkToolWithExecuteSpy(name: string, onExecute?: () => void) {
	return {
		name,
		label: name,
		description: `SDK tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => {
			onExecute?.();
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

function extensionWithTool(name: string, onExecute?: () => void): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name,
			label: name,
			description: `Extension tool ${name}`,
			parameters: Type.Object({}),
			execute: async () => {
				onExecute?.();
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		});
	};
}

/**
 * Build an AgentSession with a controllable agent stream and a real
 * model/auth runtime so prompt() preflight reaches the capability-readiness
 * gate before any provider or tool execution.
 */
async function createControlledSession(opts: {
	resourceLoader: ResourceLoader;
	settingsManager: SettingsManager;
	customTools?: ToolDefinition[];
	mcpTransportFactory?: unknown;
	onStreamCall?: () => void;
}): Promise<{ session: AgentSession; dir: string }> {
	const { dir } = tmpDir("controlled");
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
		resourceLoader: opts.resourceLoader,
		customTools: opts.customTools,
		mcpTransportFactory: opts.mcpTransportFactory as never,
	});
	return { session, dir };
}

// ---------------------------------------------------------------------------
// In-memory MCP mock server (no real process or network).
// ---------------------------------------------------------------------------

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(serverCleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
});

function createMockMcpServer(opts: {
	tools: Tool[];
	receivedCalls: Array<{ name: string; args: unknown }>;
	listToolsError?: unknown;
}): {
	transportFactory: (config: { id: string }) => Promise<unknown>;
} {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		if (opts.listToolsError !== undefined) {
			throw opts.listToolsError;
		}
		return { tools: [...opts.tools] };
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		opts.receivedCalls.push({ name: request.params.name, args: request.params.arguments });
		return { content: [{ type: "text", text: `ok:${request.params.name}` }] };
	});

	const serverReady = server.connect(serverTransport);
	serverReady.catch(() => undefined);

	serverCleanups.push(async () => {
		await server.close().catch(() => undefined);
		await clientTransport.close().catch(() => undefined);
	});

	return { transportFactory: async () => clientTransport };
}

// ---------------------------------------------------------------------------
// Controllable assistant stream for the frozen-binding mid-run test.
// ---------------------------------------------------------------------------

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

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentSession capability binding integration", () => {
	describe("static binding from profile", () => {
		it("resolves a frozen binding that selects builtin and SDK tools by default", async () => {
			const { dir, agentDir } = tmpDir("static");
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					customTools: [sdkTool("sdk_helper")],
				});
				await session.whenCapabilitiesReady();

				const binding = session.getActiveCapabilityBinding();
				expect(binding).toBeDefined();
				expect(binding!.profile).toBe("default");
				expect(binding!.toolAllowlist).toEqual(
					expect.arrayContaining(["read", "bash", "sdk_helper"]),
				);
				expect(binding!.descriptors.map((ref) => ref.id)).toEqual(
					expect.arrayContaining([
						"builtin_tool:builtin:read",
						"builtin_tool:builtin:bash",
						"sdk_tool:sdk:sdk_helper",
					]),
				);
				expect(session.getCapabilityBindingId()).toBe(binding!.id);
				expect(session.getActiveToolNames()).toEqual(
					expect.arrayContaining(["read", "sdk_helper"]),
				);
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("denies a builtin tool through the profile and keeps others exposed", async () => {
			const { dir, agentDir } = tmpDir("deny");
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "builtin_tool" }, action: "allow" },
								{ selector: { id: "builtin_tool:builtin:read" }, action: "deny" },
							],
						},
					},
				},
			});
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
				});
				await session.whenCapabilitiesReady();

				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("read");
				expect(session.getActiveToolNames()).not.toContain("read");
				expect(session.getActiveToolNames()).toContain("bash");
				expect(session.getActiveCapabilityBinding()?.toolAllowlist).not.toContain("read");
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("MCP selection, trust and namespacing", () => {
		it("connects a trusted selected server, namespaces its tools, and exposes them", async () => {
			const { dir, agentDir } = tmpDir("mcp");
			const receivedCalls: Array<{ name: string; args: unknown }> = [];
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "mcp_server" }, action: "allow" },
								{ selector: { kind: "mcp_tool" }, action: "allow" },
							],
						},
					},
				},
				mcp: {
					servers: {
						docs: { transport: "stdio", command: "node" },
					},
				},
			});
			const mock = createMockMcpServer({
				tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
				receivedCalls,
			});
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					mcpTransportFactory: mock.transportFactory as never,
				});
				await session.whenCapabilitiesReady();

				expect(session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id)).toEqual(
					expect.arrayContaining(["mcp_server:mcp:global:docs", "mcp_tool:mcp:global:docs:list"]),
				);
				expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
				expect(session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__list");
				expect(session.getActiveToolNames()).toContain("mcp__docs__list");
				expect(session.getMcpConnectionStatus("docs")).toMatchObject({
					state: "ready",
					availability: "available",
				});

				const definition = session.getToolDefinition("mcp__docs__list")!;
				const execute = definition.execute as unknown as (
					toolCallId: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
				) => Promise<{ content: Array<{ type: string; text: string }> }>;
				const result = await execute("call-1", { q: 1 }, undefined);
				expect(result.content).toContainEqual({ type: "text", text: "ok:list" });
				expect(receivedCalls).toContainEqual({ name: "list", args: { q: 1 } });
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails capability readiness when a selected MCP server cannot list tools", async () => {
			const { dir, agentDir } = tmpDir("mcp-discovery-failure");
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "mcp_server" }, action: "allow" },
								{ selector: { kind: "mcp_tool" }, action: "allow" },
							],
						},
					},
				},
				mcp: {
					servers: {
						docs: { transport: "stdio", command: "node" },
					},
				},
			});
			const mock = createMockMcpServer({
				tools: [],
				receivedCalls: [],
				listToolsError: new Error("remote list failure with secret-token"),
			});
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					mcpTransportFactory: mock.transportFactory as never,
				});

				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "capability_mcp_unavailable",
				});
				expect(session.getMcpConnectionStatus("docs")).toMatchObject({
					state: "degraded",
					availability: "degraded",
				});
				expect(JSON.stringify(session.getMcpConnectionStatus("docs"))).not.toContain("secret-token");
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("never connects an untrusted project MCP server even when the profile allows it", async () => {
			const { dir, agentDir } = tmpDir("mcp-untrusted");
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					capabilities: {
						defaultProfile: "default",
						profiles: {
							default: {
								rules: [
									{ selector: { kind: "mcp_server" }, action: "allow" },
									{ selector: { kind: "mcp_tool" }, action: "allow" },
								],
							},
						},
					},
				}),
			);
			mkdirSync(join(dir, ".aos-agent"), { recursive: true });
			writeFileSync(
				join(dir, ".aos-agent", "settings.json"),
				JSON.stringify({ mcp: { servers: { docs: { transport: "stdio", command: "node" } } } }),
			);

			const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: false });
			const sessionManager = SessionManager.inMemory(dir);
			let factoryCalls = 0;
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					mcpTransportFactory: (async () => {
						factoryCalls++;
						throw new Error("must never be called");
					}) as never,
				});
				await session.whenCapabilitiesReady();

				expect(factoryCalls).toBe(0);
				const binding = session.getActiveCapabilityBinding();
				expect(binding?.descriptors.some((ref) => ref.id.startsWith("mcp_server:"))).toBe(false);
				expect(session.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
				expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "configured" });
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps mcp_tool descriptor ids distinct across same-scope servers with the same local tool", async () => {
			const { dir, agentDir } = tmpDir("mcp-distinct");
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "mcp_server" }, action: "allow" },
								{ selector: { kind: "mcp_tool" }, action: "allow" },
							],
						},
					},
				},
				mcp: {
					servers: {
						docs: { transport: "stdio", command: "node" },
						git: { transport: "stdio", command: "node" },
					},
				},
			});
			const clientTransports = new Map<string, unknown>();
			for (const id of ["docs", "git"]) {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				const server = new Server({ name: `mock-${id}`, version: "1.0.0" }, { capabilities: { tools: {} } });
				server.setRequestHandler(ListToolsRequestSchema, async () => ({
					tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
				}));
				server.setRequestHandler(CallToolRequestSchema, async (request) => ({
					content: [{ type: "text", text: `ok:${request.params.name}` }],
				}));
				server.connect(serverTransport).catch(() => undefined);
				clientTransports.set(id, clientTransport);
				serverCleanups.push(async () => {
					await server.close().catch(() => undefined);
					await clientTransport.close().catch(() => undefined);
				});
			}
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					mcpTransportFactory: (async (config: { id: string }) => clientTransports.get(config.id)) as never,
				});
				await session.whenCapabilitiesReady();

				const binding = session.getActiveCapabilityBinding();
				const toolIds = binding?.descriptors
					.filter((ref) => ref.id.startsWith("mcp_tool:"))
					.map((ref) => ref.id)
					.sort();
				expect(toolIds).toEqual(["mcp_tool:mcp:global:docs:list", "mcp_tool:mcp:global:git:list"]);
				expect(binding?.toolAllowlist).toEqual(
					expect.arrayContaining(["mcp__docs__list", "mcp__git__list"]),
				);
				expect(session.getAllTools().map((tool) => tool.name)).toEqual(
					expect.arrayContaining(["mcp__docs__list", "mcp__git__list"]),
				);
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("final tool narrowing", () => {
		it("keeps tools/excludeTools/noTools as the final narrowing of the binding", async () => {
			const { dir, agentDir } = tmpDir("narrow");
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					excludeTools: ["bash"],
				});
				await session.whenCapabilitiesReady();

				expect(session.getActiveCapabilityBinding()?.toolAllowlist).not.toContain("bash");
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
				expect(session.getActiveToolNames()).toContain("read");

				// excludeTools is a final narrowing only: the bash builtin capability
				// stays selected in the binding; only the model-visible allowlist and
				// exposed tools omit it.
				expect(session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id)).toContain(
					"builtin_tool:builtin:bash",
				);
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("noTools all removes every model-visible tool while keeping selected capabilities", async () => {
			const { dir, agentDir } = tmpDir("notools");
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					noTools: "all",
				});
				await session.whenCapabilitiesReady();

				expect(session.getActiveCapabilityBinding()?.toolAllowlist).toEqual([]);
				expect(session.getAllTools()).toEqual([]);
				expect(session.getActiveToolNames()).toEqual([]);
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("noTools builtin disables builtins but keeps SDK custom tools", async () => {
			const { dir, agentDir } = tmpDir("notools-builtin");
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					noTools: "builtin",
					customTools: [sdkTool("sdk_helper")],
				});
				await session.whenCapabilitiesReady();

				expect(session.getActiveToolNames()).not.toContain("read");
				expect(session.getActiveToolNames()).toContain("sdk_helper");
				// Built-ins remain registered for extension/tool inspection, but are not
				// active when noTools is set to "builtin".
				expect(session.getAllTools().map((tool) => tool.name)).toContain("bash");
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("frozen binding across a live run", () => {
		it("does not mutate the active run's tools via setActiveTools or a dynamic refresh mid-run", async () => {
			const { dir, agentDir } = tmpDir("frozen");
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			let releaseStream: ((message: AssistantMessage) => void) | undefined;
			const gate = new Promise<AssistantMessage>((resolve) => {
				releaseStream = resolve;
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						void gate.then((message) => {
							stream.push({ type: "done", reason: "stop", message });
						});
					});
					return stream;
				},
			});

			const sessionManager = SessionManager.inMemory(dir);
			const settingsManager = SettingsManager.create(dir, agentDir);
			const authStorage = AuthStorage.create(join(dir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage, dir);
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			const resourceLoader = createTestResourceLoader();

			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: dir,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});
			try {
				const runPromise = session.prompt("First message");
				await waitUntil(() => session.isStreaming);

				expect(session.getActiveToolNames()).toContain("read");

				const bindingBefore = session.getActiveCapabilityBinding()?.id;

				// Active tool selection may change during the run, but it must not
				// rebuild the frozen capability binding.
				session.setActiveToolsByName(["read"]);
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.getActiveCapabilityBinding()?.id).toBe(bindingBefore);
				// A dynamic tool-registry refresh during the run must also be deferred.
				session.resourceLoader.getExtensions().runtime.refreshTools();
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.getActiveCapabilityBinding()?.id).toBe(bindingBefore);

				releaseStream?.(createAssistantMessage("Done"));
				await runPromise;

				// The frozen binding remains unchanged, and the active subset is retained.
				expect(session.getActiveToolNames()).toEqual(["read"]);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("starts MCP discovery lazily and gates the first prompt on readiness", async () => {
			const { dir } = tmpDir("mcp-lazy");
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "mcp_server" }, action: "allow" },
								{ selector: { kind: "mcp_tool" }, action: "allow" },
							],
						},
					},
				},
				mcp: {
					servers: {
						docs: { transport: "stdio", command: "node" },
					},
				},
			});
			const receivedCalls: Array<{ name: string; args: unknown }> = [];
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
			}));
			server.setRequestHandler(CallToolRequestSchema, async (request) => {
				receivedCalls.push({ name: request.params.name, args: request.params.arguments });
				return { content: [{ type: "text", text: `ok:${request.params.name}` }] };
			});
			server.connect(serverTransport).catch(() => undefined);
			serverCleanups.push(async () => {
				await server.close().catch(() => undefined);
				await clientTransport.close().catch(() => undefined);
			});

			let releaseDiscovery: (() => void) | undefined;
			const discoveryGate = new Promise<void>((resolve) => {
				releaseDiscovery = resolve;
			});
			let factoryCalls = 0;
			const transportFactory = async () => {
				factoryCalls++;
				await discoveryGate;
				return clientTransport;
			};

			let streamCalls = 0;
			const { session } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager,
				mcpTransportFactory: transportFactory,
				onStreamCall: () => streamCalls++,
			});
			try {
				// Lazy discovery: runtime construction never connects to servers.
				expect(factoryCalls).toBe(0);
				expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "configured" });
				expect(session.getActiveToolNames()).not.toContain("mcp__docs__list");

				const runPromise = session.prompt("First message");
				// Prompt preflight gates on readiness: discovery starts but the run
				// does not begin (no provider/tool execution) until it settles.
				await waitUntil(() => factoryCalls === 1);
				expect(session.isStreaming).toBe(false);
				expect(streamCalls).toBe(0);

				releaseDiscovery?.();
				await runPromise;

				expect(streamCalls).toBe(1);
				expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
				expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
				expect(session.getActiveToolNames()).toContain("mcp__docs__list");
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("defers reload until an active run settles so the frozen binding is never rebuilt mid-run", async () => {
			const { dir, agentDir } = tmpDir("reload-midrun");
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			let releaseStream: ((message: AssistantMessage) => void) | undefined;
			const gate = new Promise<AssistantMessage>((resolve) => {
				releaseStream = resolve;
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						void gate.then((message) => {
							stream.push({ type: "done", reason: "stop", message });
						});
					});
					return stream;
				},
			});

			const sessionManager = SessionManager.inMemory(dir);
			const settingsManager = SettingsManager.create(dir, agentDir);
			const authStorage = AuthStorage.create(join(dir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage, dir);
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			const resourceLoader = createTestResourceLoader();

			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: dir,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});
			try {
				const runPromise = session.prompt("First message");
				await waitUntil(() => session.isStreaming);

				const before = session.getActiveToolNames();
				const bindingBefore = session.getActiveCapabilityBinding()?.id;
				expect(before).toContain("read");

				// reload blocks on the active run and must not rebuild the binding.
				let reloadResolved = false;
				const reloadPromise = session.reload().then(() => {
					reloadResolved = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(reloadResolved).toBe(false);
				expect(session.isStreaming).toBe(true);
				expect(session.getActiveToolNames()).toEqual(before);
				expect(session.getActiveCapabilityBinding()?.id).toBe(bindingBefore);

				releaseStream?.(createAssistantMessage("Done"));
				await runPromise;
				await reloadPromise;
				expect(reloadResolved).toBe(true);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("secret-free context metadata from the binding", () => {
		it("carries descriptor/revision/binding identity on skill index and provider tool sources", async () => {
			const { dir, agentDir } = tmpDir("ctx");
			const settingsManager = SettingsManager.inMemory();
			const sessionManager = SessionManager.inMemory(dir);
			const resourceLoader = loaderWithSkills([skill("test-skill")]);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					resourceLoader,
					customTools: [sdkTool("sdk_helper")],
					model: getModel("anthropic", "claude-sonnet-4-5")!,
				});
				await session.whenCapabilitiesReady();

				const bindingId = session.getCapabilityBindingId();
				expect(bindingId).toMatch(/^binding:/);
				const { snapshot } = await session.inspectContext();

				const skillSource = snapshot.sources.find((source) => source.sourceId === "capability_index:skills");
				expect(skillSource).toBeDefined();
				expect(skillSource?.capabilityBindingId).toBe(bindingId);

				const sdkSource = snapshot.sources.find((source) => source.sourceId === "capability:tool:sdk_helper");
				expect(sdkSource?.capabilityId).toBe("sdk_tool:sdk:sdk_helper");
				expect(sdkSource?.capabilityRevision).toMatch(/^rev:/);
				expect(sdkSource?.capabilityBindingId).toBe(bindingId);

				const readSource = snapshot.sources.find((source) => source.sourceId === "capability:tool:read");
				expect(readSource?.capabilityId).toBe("builtin_tool:builtin:read");

				// The snapshot remains metadata-only: no content, no secrets.
				expect(() => assertSnapshotMetadataOnly(snapshot)).not.toThrow();
				const serialized = JSON.stringify(snapshot);
				expect(serialized).not.toContain('"content"');
			} finally {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("static catalog collisions fail closed", () => {
		it("fails closed with capability_name_conflict on a selected builtin/SDK name collision", async () => {
			let executeCalls = 0;
			let streamCalls = 0;
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: SettingsManager.inMemory(),
				customTools: [sdkToolWithExecuteSpy("read", () => executeCalls++)],
				onStreamCall: () => streamCalls++,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				// The conflict surfaces through prompt preflight before any
				// provider request or tool execution.
				await expect(session.prompt("run")).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				expect(streamCalls).toBe(0);
				expect(executeCalls).toBe(0);
				// Fail closed: no ambiguous tool set is materialized.
				expect(session.getActiveToolNames()).toEqual([]);
				expect(session.getActiveCapabilityBinding()).toBeUndefined();
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails closed with capability_name_conflict on a selected builtin/extension name collision", async () => {
			let executeCalls = 0;
			let streamCalls = 0;
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("read", () => executeCalls++) },
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const { session, dir } = await createControlledSession({
				resourceLoader,
				settingsManager: SettingsManager.inMemory(),
				onStreamCall: () => streamCalls++,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				await expect(session.prompt("run")).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				expect(streamCalls).toBe(0);
				expect(executeCalls).toBe(0);
				expect(session.getActiveToolNames()).toEqual([]);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails closed with capability_name_conflict on a selected extension/SDK name collision", async () => {
			let extensionExecuteCalls = 0;
			let sdkExecuteCalls = 0;
			let streamCalls = 0;
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("shared", () => extensionExecuteCalls++) },
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const { session, dir } = await createControlledSession({
				resourceLoader,
				settingsManager: SettingsManager.inMemory(),
				customTools: [sdkToolWithExecuteSpy("shared", () => sdkExecuteCalls++)],
				onStreamCall: () => streamCalls++,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				await expect(session.prompt("run")).rejects.toMatchObject({
					code: "capability_name_conflict",
				});
				expect(streamCalls).toBe(0);
				expect(extensionExecuteCalls).toBe(0);
				expect(sdkExecuteCalls).toBe(0);
				expect(session.getActiveToolNames()).toEqual([]);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("metadata-only extension descriptors govern child tools", () => {
		it("links extension_tool descriptors to their extension descriptor via parentId", async () => {
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper") },
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const { session, dir } = await createControlledSession({
				resourceLoader,
				settingsManager: SettingsManager.inMemory(),
			});
			try {
				await session.whenCapabilitiesReady();

				expect(session.getActiveToolNames()).toContain("ext_helper");
				const view = session.inspectCapabilityCatalog();
				const ext = view.descriptors.find((descriptor) => descriptor.kind === "extension");
				const extTool = view.descriptors.find((descriptor) => descriptor.kind === "extension_tool");
				expect(ext).toBeDefined();
				expect(extTool).toBeDefined();
				expect(extTool?.parentId).toBe(ext?.id);
				// The extension descriptor is metadata-only: it exposes no tool name.
				expect(ext?.exposedToolName).toBeUndefined();
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("denies extension tools when their extension descriptor is profile-denied", async () => {
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper") },
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "builtin_tool" }, action: "allow" },
								{ selector: { kind: "extension" }, action: "deny" },
							],
						},
					},
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader,
				settingsManager,
			});
			try {
				await session.whenCapabilitiesReady();

				expect(session.getActiveToolNames()).not.toContain("ext_helper");
				expect(
					session
						.getActiveCapabilityBinding()
						?.descriptors.some((ref) => ref.id.includes("extension_tool")),
				).toBe(false);
				// The extension descriptor stays in the catalog (metadata-only), but
				// its profile denial governs the child tools: none enter the binding.
				const view = session.inspectCapabilityCatalog();
				const ext = view.descriptors.find((descriptor) => descriptor.kind === "extension");
				expect(ext).toBeDefined();
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("static catalog revision inputs", () => {
		it("changes the skill revision and binding when SKILL.md content changes on reload", async () => {
			const { dir, agentDir } = tmpDir("skill-rev");
			const skillFilePath = join(dir, "SKILL.md");
			writeFileSync(skillFilePath, "# v1\n\ncontent one");
			const skillDef: Skill = {
				name: "rev-skill",
				description: "rev skill",
				filePath: skillFilePath,
				baseDir: dir,
				sourceInfo: createSyntheticSourceInfo("<skill:rev-skill>", { source: "skill" }),
				disableModelInvocation: false,
			};
			const resourceLoader = loaderWithSkills([skillDef]);
			const settingsManager = SettingsManager.create(dir, agentDir);
			const { session } = await createControlledSession({
				resourceLoader,
				settingsManager,
			});
			try {
				await session.whenCapabilitiesReady();
				const before = session.getActiveCapabilityBinding()!;
				const beforeRef = before.descriptors.find((ref) => ref.id === "skill:skill:rev-skill");
				expect(beforeRef).toBeDefined();

				writeFileSync(skillFilePath, "# v2\n\ncontent two");
				await session.reload();

				const after = session.getActiveCapabilityBinding()!;
				const afterRef = after.descriptors.find((ref) => ref.id === "skill:skill:rev-skill");
				expect(afterRef).toBeDefined();
				expect(afterRef!.revision).not.toBe(beforeRef!.revision);
				expect(after.id).not.toBe(before.id);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("changes the tool revision and binding when a tool schema/description changes on reload", async () => {
			const { dir, agentDir } = tmpDir("tool-rev");
			const tool = {
				name: "schema_tool",
				label: "schema_tool",
				description: "v1 description",
				parameters: Type.Object({ query: Type.String() }),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			};
			const resourceLoader = createTestResourceLoader();
			const settingsManager = SettingsManager.create(dir, agentDir);
			const { session } = await createControlledSession({
				resourceLoader,
				settingsManager,
				customTools: [tool],
			});
			try {
				await session.whenCapabilitiesReady();
				const before = session.getActiveCapabilityBinding()!;
				const beforeRef = before.descriptors.find((ref) => ref.id === "sdk_tool:sdk:schema_tool");
				expect(beforeRef).toBeDefined();

				// A public behavior change (schema + description) must re-fingerprint.
				tool.description = "v2 description";
				tool.parameters = Type.Object({ query: Type.String(), limit: Type.Number() });
				await session.reload();

				const after = session.getActiveCapabilityBinding()!;
				const afterRef = after.descriptors.find((ref) => ref.id === "sdk_tool:sdk:schema_tool");
				expect(afterRef).toBeDefined();
				expect(afterRef!.revision).not.toBe(beforeRef!.revision);
				expect(after.id).not.toBe(before.id);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
