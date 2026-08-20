import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
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
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import {
	CapabilityRegistry,
	createCapabilityBindingView,
	createCapabilityId,
} from "../src/core/capability-registry.ts";
import { assertSnapshotMetadataOnly } from "../src/core/context-engine.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../src/core/resource-loader.ts";
import type { SandboxHandle, SandboxProvider } from "../src/core/sandbox.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { ExtensionFactory, LoadExtensionsResult, ToolDefinition } from "../src/core/extensions/index.ts";
import type { MCPEnvResolver, MCPServerConfig } from "../src/core/mcp-types.ts";
import { createFakeSandboxProvider } from "./fixtures/fake-sandbox-provider.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `aos-capabilities-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	return (agent) => {
		agent.registerTool({
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
	sandboxProviders?: ReadonlyArray<SandboxProvider>;
	onStreamCall?: () => void;
	dir?: string;
	agentDir?: string;
}): Promise<{ session: AgentSession; dir: string; agentDir: string; identity: CapabilityPublicIdentity }> {
	if ((opts.dir === undefined) !== (opts.agentDir === undefined)) {
		throw new Error("createControlledSession requires both dir and agentDir when either is provided");
	}
	const temp = opts.dir === undefined ? tmpDir("controlled") : undefined;
	const dir = opts.dir ?? temp!.dir;
	const agentDir = opts.agentDir ?? temp!.agentDir;
	mkdirSync(agentDir, { recursive: true });
	const identity = await CapabilityPublicIdentity.load(agentDir);
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
		sandboxProviders: opts.sandboxProviders,
		capabilityRegistry: new CapabilityRegistry(identity),
	});
	return { session, dir, agentDir, identity };
}

function executionPolicySettings(options?: {
	profileId?: string;
	process?: "allow" | "deny";
	network?: "allow" | "deny";
	networkApproval?: "allow" | "deny";
	extensionInvoke?: "allow" | "deny";
	enforcement?: "host" | "sandbox";
	sandboxProvider?: string;
	credentialAction?: "allow" | "ask" | "deny";
	credentialApproval?: "allow" | "ask" | "deny";
	credentialNames?: ReadonlyArray<string>;
	environmentNames?: ReadonlyArray<string>;
}) {
	const profileId = options?.profileId ?? "locked";
	const profile = {
		id: profileId,
		enforcement: options?.enforcement ?? "host",
		...(options?.sandboxProvider === undefined ? {} : { sandboxProvider: options.sandboxProvider }),
		defaultAction: "allow",
		workspace: {
			read: ["workspace", "declared-read-only"],
			write: ["workspace"],
			deny: ["credentials", "agent-internal"],
		},
		process: {
			action: options?.process ?? "allow",
			inheritEnvironment: false,
			allowEnvironment: [...(options?.environmentNames ?? ["PATH"])],
			cwdScopes: ["workspace"],
			timeoutMs: 60_000,
		},
		network: { action: options?.network ?? "allow", allowDestinations: [] },
		credentials:
			options?.credentialNames === undefined && options?.credentialAction === undefined
				? { action: "deny", allowNames: [] }
				: {
						action: options?.credentialAction ?? "allow",
						allowNames: [...(options?.credentialNames ?? [])],
					},
		approvals: {
			writeOutsideWorkspace: "deny",
			network: options?.networkApproval ?? "deny",
			process: options?.process ?? "allow",
			...(options?.credentialNames === undefined && options?.credentialAction === undefined
				? {}
				: { credentials: options?.credentialApproval ?? options?.credentialAction ?? ("allow" as const) }),
		},
		rules:
			options?.extensionInvoke === undefined
				? []
				: [{ resource: "capability.invoke", source: "extension", action: options.extensionInvoke }],
	};
	return {
		defaultProfile: profileId,
		profiles: { [profileId]: profile },
	};
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
	return {
		transportFactory: async () => {
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

			server.connect(serverTransport).catch(() => undefined);
			serverCleanups.push(async () => {
				await server.close().catch(() => undefined);
				await clientTransport.close().catch(() => undefined);
			});
			return clientTransport;
		},
	};
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
			const identity = await CapabilityPublicIdentity.load(agentDir);
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
						createCapabilityId("builtin_tool", "builtin", "read", identity),
						createCapabilityId("builtin_tool", "builtin", "bash", identity),
						createCapabilityId("sdk_tool", "sdk", "sdk_helper", identity),
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
			const identity = await CapabilityPublicIdentity.load(agentDir);
			const readId = createCapabilityId("builtin_tool", "builtin", "read", identity);
			const settingsManager = SettingsManager.inMemory({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "builtin_tool" }, action: "allow" },
								{ selector: { id: readId }, action: "deny" },
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
			const identity = await CapabilityPublicIdentity.load(agentDir);
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
					expect.arrayContaining([
						createCapabilityId("mcp_server", "mcp:global", "docs", identity),
						createCapabilityId("mcp_tool", "mcp:global:docs", "list", identity),
					]),
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
			const identity = await CapabilityPublicIdentity.load(agentDir);
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
			const transportFactories = new Map<string, () => unknown>();
			for (const id of ["docs", "git"]) {
				transportFactories.set(id, () => {
					const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
					const server = new Server({ name: `mock-${id}`, version: "1.0.0" }, { capabilities: { tools: {} } });
					server.setRequestHandler(ListToolsRequestSchema, async () => ({
						tools: [{ name: "list", inputSchema: { type: "object", properties: {} } }],
					}));
					server.setRequestHandler(CallToolRequestSchema, async (request) => ({
						content: [{ type: "text", text: `ok:${request.params.name}` }],
					}));
					server.connect(serverTransport).catch(() => undefined);
					serverCleanups.push(async () => {
						await server.close().catch(() => undefined);
						await clientTransport.close().catch(() => undefined);
					});
					return clientTransport;
				});
			}
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const { session } = await createAgentSession({
					cwd: dir,
					agentDir,
					settingsManager,
					sessionManager,
					mcpTransportFactory: (async (config: { id: string }) => transportFactories.get(config.id)?.()) as never,
				});
				await session.whenCapabilitiesReady();

				const binding = session.getActiveCapabilityBinding();
				const toolIds = binding?.descriptors
					.filter((ref) => ref.id.startsWith("mcp_tool:"))
					.map((ref) => ref.id)
					.sort();
				expect(toolIds).toEqual(
					[
						createCapabilityId("mcp_tool", "mcp:global:docs", "list", identity),
						createCapabilityId("mcp_tool", "mcp:global:git", "list", identity),
					].sort(),
				);
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
			const identity = await CapabilityPublicIdentity.load(agentDir);
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
					createCapabilityId("builtin_tool", "builtin", "bash", identity),
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
			let releaseDiscovery: (() => void) | undefined;
			const discoveryGate = new Promise<void>((resolve) => {
				releaseDiscovery = resolve;
			});
			let factoryCalls = 0;
			const transportFactory = async () => {
				factoryCalls++;
				await discoveryGate;
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
				// Prompt preflight reserves the run while readiness is pending, but no
				// provider or tool execution begins until discovery settles.
				await waitUntil(() => factoryCalls === 1);
				expect(session.isStreaming).toBe(true);
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
			let streamStarted = false;
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
						streamStarted = true;
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
			const baseResourceLoader = createTestResourceLoader();
			let resourceReloadStarted = false;
			const resourceLoader: ResourceLoader = {
				...baseResourceLoader,
				reload: async () => {
					resourceReloadStarted = true;
					await baseResourceLoader.reload();
				},
			};

			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: dir,
				modelRuntime: getModelRuntime(modelRegistry),
				resourceLoader,
			});
			let runPromise: Promise<void> | undefined;
			let reloadPromise: Promise<void> | undefined;
			try {
				runPromise = session.prompt("First message");
				await waitUntil(() => streamStarted && session.isStreaming);

				const before = session.getActiveToolNames();
				const bindingBefore = session.getActiveCapabilityBinding()?.id;
				expect(before).toContain("read");

				// reload blocks on the active run and must not rebuild the binding.
				reloadPromise = session.reload();
				await Promise.resolve();
				expect(resourceReloadStarted).toBe(false);
				expect(session.isStreaming).toBe(true);
				expect(session.getActiveToolNames()).toEqual(before);
				expect(session.getActiveCapabilityBinding()?.id).toBe(bindingBefore);

				releaseStream?.(createAssistantMessage("Done"));
				await runPromise;
				await reloadPromise;
				expect(resourceReloadStarted).toBe(true);
			} finally {
				releaseStream?.(createAssistantMessage("Done"));
				await runPromise?.catch(() => undefined);
				await reloadPromise?.catch(() => undefined);
				await session.abort();
				session.dispose();
				await session.waitForDispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("secret-free context metadata from the binding", () => {
		it("carries descriptor/revision/binding identity on skill index and provider tool sources", async () => {
			const { dir, agentDir } = tmpDir("ctx");
			const identity = await CapabilityPublicIdentity.load(agentDir);
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
				expect(sdkSource?.capabilityId).toBe(
					createCapabilityId("sdk_tool", "sdk", "sdk_helper", identity),
				);
				expect(sdkSource?.capabilityRevision).toMatch(/^rev:/);
				expect(sdkSource?.capabilityBindingId).toBe(bindingId);

				const readSource = snapshot.sources.find((source) => source.sourceId === "capability:tool:read");
				expect(readSource?.capabilityId).toBe(
					createCapabilityId("builtin_tool", "builtin", "read", identity),
				);

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
		it("reports a rejected preflight and settles the Agent run on a capability conflict", async () => {
			let streamCalls = 0;
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: SettingsManager.inMemory(),
				customTools: [sdkToolWithExecuteSpy("read")],
				onStreamCall: () => streamCalls++,
			});
			try {
				const preflightResults: boolean[] = [];

				await expect(
					session.prompt("run", {
						source: "rpc",
						preflightResult: (success) => preflightResults.push(success),
					}),
				).rejects.toMatchObject({ code: "capability_name_conflict" });

				expect(preflightResults).toEqual([false]);
				expect(session.isStreaming).toBe(false);
				await expect(session.agent.waitForIdle()).resolves.toBeUndefined();
				expect(streamCalls).toBe(0);
				expect(session.getActiveToolNames()).toEqual([]);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

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

		it("fails closed on a collision between two extensions registering the same exposed name", async () => {
			let ext1ExecuteCalls = 0;
			let ext2ExecuteCalls = 0;
			let streamCalls = 0;
			// Two distinct extension sources register the SAME exposed tool name.
			// The capability catalog must include BOTH per-extension tools (the
			// runner's first-registration dedup is only a runtime concern), so the
			// registry sees the collision and fails closed before any provider or
			// tool execution.
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("shared", () => ext1ExecuteCalls++) },
				{ name: "ext2", factory: extensionWithTool("shared", () => ext2ExecuteCalls++) },
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
				expect(ext1ExecuteCalls).toBe(0);
				expect(ext2ExecuteCalls).toBe(0);
				// Fail closed: no ambiguous tool set is materialized.
				expect(session.getActiveToolNames()).toEqual([]);
				expect(session.getActiveCapabilityBinding()).toBeUndefined();
				// Both per-extension tools reached the catalog, each linked to its
				// own extension descriptor via parentId.
				const view = session.inspectCapabilityCatalog();
				const extTools = view.descriptors.filter((descriptor) => descriptor.kind === "extension_tool");
				expect(extTools).toHaveLength(2);
				expect(extTools.map((tool) => tool.exposedToolName)).toEqual(["shared", "shared"]);
				expect(new Set(extTools.map((tool) => tool.id)).size).toBe(2);
				const extensionDescriptors = view.descriptors.filter(
					(descriptor) => descriptor.kind === "extension",
				);
				expect(extTools.map((tool) => tool.parentId).sort()).toEqual(
					extensionDescriptors.map((descriptor) => descriptor.id).sort(),
				);
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
			const { session, identity } = await createControlledSession({
				resourceLoader,
				settingsManager,
				dir,
				agentDir,
			});
			try {
				await session.whenCapabilitiesReady();
				const before = session.getActiveCapabilityBinding()!;
				const skillId = createCapabilityId("skill", "skill", "rev-skill", identity);
				const beforeRef = before.descriptors.find((ref) => ref.id === skillId);
				expect(beforeRef).toBeDefined();

				writeFileSync(skillFilePath, "# v2\n\ncontent two");
				await session.reload();

				const after = session.getActiveCapabilityBinding()!;
				const afterRef = after.descriptors.find((ref) => ref.id === skillId);
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
			const { session, identity } = await createControlledSession({
				resourceLoader,
				settingsManager,
				customTools: [tool],
				dir,
				agentDir,
			});
			try {
				await session.whenCapabilitiesReady();
				const before = session.getActiveCapabilityBinding()!;
				const toolId = createCapabilityId("sdk_tool", "sdk", "schema_tool", identity);
				const beforeRef = before.descriptors.find((ref) => ref.id === toolId);
				expect(beforeRef).toBeDefined();

				// A public behavior change (schema + description) must re-fingerprint.
				tool.description = "v2 description";
				tool.parameters = Type.Object({ query: Type.String(), limit: Type.Number() });
				await session.reload();

				const after = session.getActiveCapabilityBinding()!;
				const afterRef = after.descriptors.find((ref) => ref.id === toolId);
				expect(afterRef).toBeDefined();
				expect(afterRef!.revision).not.toBe(beforeRef!.revision);
				expect(after.id).not.toBe(before.id);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("trusted project resource candidates", () => {
		function scopeExtensions(extensionsResult: LoadExtensionsResult, scope: "project" | "user"): void {
			for (const extension of extensionsResult.extensions) {
				extension.sourceInfo = createSyntheticSourceInfo(extension.path, {
					source: extension.sourceInfo.source,
					scope,
					baseDir: extension.sourceInfo.baseDir,
				});
				for (const tool of extension.tools.values()) {
					tool.sourceInfo = extension.sourceInfo;
				}
			}
		}

		function projectSkill(name: string, baseDir: string): Skill {
			return {
				name,
				description: `project skill ${name}`,
				filePath: join(baseDir, "SKILL.md"),
				baseDir,
				sourceInfo: createSyntheticSourceInfo(`<skill:${name}>`, { source: "skill", scope: "project" }),
				disableModelInvocation: false,
			};
		}

		it("trusts project extension, extension tool, and skill descriptors and includes them in the binding", async () => {
			const { dir, agentDir } = tmpDir("trusted-project");
			const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: true });
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper") },
			]);
			scopeExtensions(extensionsResult, "project");
			const resourceLoader = {
				...createTestResourceLoader({ extensionsResult }),
				getSkills: () => ({ skills: [projectSkill("proj-skill", dir)], diagnostics: [] }),
			};
			const { session, dir: sessionDir } = await createControlledSession({ resourceLoader, settingsManager });
			try {
				await session.whenCapabilitiesReady();

				const view = session.inspectCapabilityCatalog();
				expect(view.descriptors.find((descriptor) => descriptor.kind === "extension")?.trusted).toBe(true);
				expect(view.descriptors.find((descriptor) => descriptor.kind === "extension_tool")?.trusted).toBe(true);
				expect(view.descriptors.find((descriptor) => descriptor.kind === "skill")?.trusted).toBe(true);

				const bindingIds = session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id) ?? [];
				expect(bindingIds.some((id) => id.startsWith("extension:"))).toBe(true);
				expect(bindingIds.some((id) => id.startsWith("extension_tool:"))).toBe(true);
				expect(bindingIds.some((id) => id.startsWith("skill:"))).toBe(true);
				expect(session.getAllTools().map((tool) => tool.name)).toContain("ext_helper");
				expect(session.getActiveToolNames()).toContain("ext_helper");
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
			}
		});

		it("force-denies the same project resources when the project is untrusted", async () => {
			const { dir, agentDir } = tmpDir("untrusted-project");
			const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: false });
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper") },
			]);
			scopeExtensions(extensionsResult, "project");
			const resourceLoader = {
				...createTestResourceLoader({ extensionsResult }),
				getSkills: () => ({ skills: [projectSkill("proj-skill", dir)], diagnostics: [] }),
			};
			const { session, dir: sessionDir } = await createControlledSession({ resourceLoader, settingsManager });
			try {
				await session.whenCapabilitiesReady();

				const view = session.inspectCapabilityCatalog();
				expect(view.descriptors.find((descriptor) => descriptor.kind === "extension")?.trusted).toBe(false);
				expect(view.descriptors.find((descriptor) => descriptor.kind === "extension_tool")?.trusted).toBe(false);
				expect(view.descriptors.find((descriptor) => descriptor.kind === "skill")?.trusted).toBe(false);

				const bindingIds = session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id) ?? [];
				expect(bindingIds.some((id) => id.startsWith("extension:"))).toBe(false);
				expect(bindingIds.some((id) => id.startsWith("extension_tool:"))).toBe(false);
				expect(bindingIds.some((id) => id.startsWith("skill:"))).toBe(false);
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ext_helper");
				expect(session.getActiveToolNames()).not.toContain("ext_helper");
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
			}
		});

		it("keeps user-scoped extensions trusted regardless of project trust", async () => {
			for (const projectTrusted of [true, false]) {
				const { dir, agentDir } = tmpDir(`user-extension-${projectTrusted}`);
				const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted });
				const extensionsResult = await createTestExtensionsResult([
					{ name: "user-ext", factory: extensionWithTool("user_helper") },
				]);
				scopeExtensions(extensionsResult, "user");
				const resourceLoader = createTestResourceLoader({ extensionsResult });
				const { session, dir: sessionDir } = await createControlledSession({ resourceLoader, settingsManager });
				try {
					await session.whenCapabilitiesReady();

					const view = session.inspectCapabilityCatalog();
					expect(view.descriptors.find((descriptor) => descriptor.kind === "extension")?.trusted).toBe(true);
					expect(view.descriptors.find((descriptor) => descriptor.kind === "extension_tool")?.trusted).toBe(true);

					const bindingIds = session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id) ?? [];
					expect(bindingIds.some((id) => id.startsWith("extension:"))).toBe(true);
					expect(bindingIds.some((id) => id.startsWith("extension_tool:"))).toBe(true);
					expect(session.getAllTools().map((tool) => tool.name)).toContain("user_helper");
					expect(session.getActiveToolNames()).toContain("user_helper");
				} finally {
					session.dispose();
					if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
					if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
				}
			}
		});

		it("does not weaken parent governance: denying the extension kind also denies its tool in a trusted project", async () => {
			const { dir, agentDir } = tmpDir("trusted-project-deny");
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
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
				}),
			);
			const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: true });
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper") },
			]);
			scopeExtensions(extensionsResult, "project");
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const { session, dir: sessionDir } = await createControlledSession({ resourceLoader, settingsManager });
			try {
				await session.whenCapabilitiesReady();

				const view = session.inspectCapabilityCatalog();
				const extensionDescriptor = view.descriptors.find((descriptor) => descriptor.kind === "extension");
				expect(extensionDescriptor?.trusted).toBe(true);
				const extToolDescriptor = view.descriptors.find((descriptor) => descriptor.kind === "extension_tool");
				expect(extToolDescriptor?.trusted).toBe(true);
				expect(extToolDescriptor?.parentId).toBe(extensionDescriptor?.id);

				const bindingIds = session.getActiveCapabilityBinding()?.descriptors.map((ref) => ref.id) ?? [];
				expect(bindingIds.some((id) => id.startsWith("extension_tool:"))).toBe(false);
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ext_helper");
				expect(session.getActiveToolNames()).not.toContain("ext_helper");
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
			}
		});
	});

	describe("configured package source identity", () => {
		it("keeps an absolute configured package source internal while profile matching still uses it", async () => {
			const { dir, agentDir } = tmpDir("configured-package");
			const packageDir = join(dir, "audit-private", "capability-source");
			const skillDir = join(packageDir, "skills", "audit-package-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				"---\nname: audit-package-skill\ndescription: package discovery regression skill\n---\n\nPrivate package skill.\n",
			);
			const settingsManager = SettingsManager.inMemory({
				packages: [packageDir],
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
									{ selector: { kind: "skill" }, action: "deny" },
									{ selector: { sourceId: packageDir }, action: "allow" },
								],
						},
						blocked: { rules: [{ selector: { sourceId: packageDir }, action: "deny" }] },
					},
				},
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: dir,
				agentDir,
				settingsManager,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const discoveredSkill = resourceLoader.getSkills().skills.find((candidate) => candidate.name === "audit-package-skill");
			expect(discoveredSkill?.sourceInfo?.source).toBe(packageDir);

			const { session, identity } = await createControlledSession({
				resourceLoader,
				settingsManager,
				dir,
				agentDir,
			});
			try {
				await session.whenCapabilitiesReady();
				const descriptorId = createCapabilityId("skill", packageDir, "audit-package-skill", identity);
				const catalog = session.inspectCapabilityCatalog();
				const binding = session.getActiveCapabilityBinding();
				expect(catalog.descriptors.some((descriptor) => descriptor.id === descriptorId)).toBe(true);
				expect(binding?.descriptors.some((descriptor) => descriptor.id === descriptorId)).toBe(true);
				expect(JSON.stringify({ catalog, binding: binding && createCapabilityBindingView(binding) })).not.toContain(
					packageDir,
				);
				expect(JSON.stringify({ catalog, binding: binding && createCapabilityBindingView(binding) })).not.toContain(
					"audit-private",
				);

				await session.setCapabilityProfile("blocked");
				expect(
					session.getActiveCapabilityBinding()?.descriptors.some((descriptor) => descriptor.id === descriptorId),
				).toBe(false);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("execution policy integration", () => {
		it("authorizes extension tool invocation before extension code runs", async () => {
			let extensionExecuteCalls = 0;
			const extensionsResult = await createTestExtensionsResult([
				{ name: "ext1", factory: extensionWithTool("ext_helper", () => extensionExecuteCalls++) },
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({ extensionInvoke: "deny" }),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
			});
			try {
				await session.whenCapabilitiesReady();
				const tool = session.agent.state.tools.find((candidate) => candidate.name === "ext_helper");
				expect(tool).toBeDefined();
				await expect(tool!.execute("ext-call", {})).rejects.toMatchObject({ code: "policy_denied" });
				expect(extensionExecuteCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("authorizes user_bash before extension bash handlers run", async () => {
			let extensionHandlerCalls = 0;
			const extensionsResult = await createTestExtensionsResult([
				{
					name: "bash-interceptor",
					factory: (agent) => {
						agent.on("user_bash", async () => {
							extensionHandlerCalls++;
							return {
								result: {
									output: "extension\n",
									exitCode: 0,
									cancelled: false,
									truncated: false,
								},
							};
						});
					},
				},
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({ process: "deny" }),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
			});
			try {
				await expect(
					(async () => {
						if (await session.authorizeUserBashExtension("echo no", { id: "bash-extension-deny" })) {
							await session.extensionRunner.emitUserBash({
								type: "user_bash",
								command: "echo no",
								excludeFromContext: false,
								cwd: session.sessionManager.getCwd(),
							});
						}
					})(),
				).rejects.toMatchObject({ code: "policy_denied" });
				expect(extensionHandlerCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("authorizes user_bash before custom bash operations run", async () => {
			let execStarted = false;
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({ process: "deny" }),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
			});
			try {
				await expect(
					session.executeBash("echo no", undefined, {
						id: "bash-deny",
						operations: {
							exec: async () => {
								execStarted = true;
								return { exitCode: 0 };
							},
						},
					}),
				).rejects.toMatchObject({ code: "policy_denied" });
				expect(execStarted).toBe(false);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("authorizes extension command ctx.exec before spawning a process", async () => {
			const markerPath = join(tmpdir(), `aos-extension-exec-deny-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const extensionsResult = await createTestExtensionsResult([
				{
					name: "exec-command",
					factory: (agent) => {
						agent.registerCommand("exec-deny", {
							handler: async (_args, ctx) => {
								await ctx.exec(process.execPath, [
									"-e",
									`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned")`,
								]);
							},
						});
					},
				},
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({ process: "deny" }),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
			});
			try {
				const command = session.extensionRunner.getCommand("exec-deny")!;
				await expect(command.handler("", session.extensionRunner.createCommandContext())).rejects.toMatchObject({
					code: "policy_denied",
				});
				expect(existsSync(markerPath)).toBe(false);
			} finally {
				session.dispose();
				if (existsSync(markerPath)) rmSync(markerPath, { force: true });
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("routes strict extension ctx.exec through the sandbox handle with filtered env", async () => {
			const sandboxRequests: Array<{ command?: string; args?: ReadonlyArray<string>; env?: NodeJS.ProcessEnv; bindingId?: string }> = [];
			const handle: SandboxHandle = {
				id: "handle-extension-exec",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async (request) => {
					sandboxRequests.push({
						command: request.command,
						args: request.args,
						env: request.env,
						bindingId: request.bindingId,
					});
					request.onData?.(Buffer.from("sandboxed\n"));
					return { exitCode: 0 };
				},
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			let stdout = "";
			const extensionsResult = await createTestExtensionsResult([
				{
					name: "exec-event",
					factory: (agent) => {
						agent.on("agent_start", async (_event, ctx) => {
							const execResult = await ctx.exec("definitely-not-a-host-command", ["--flag"], {
								env: { EXT_ALLOWED: "yes", EXT_SECRET: "no" },
							});
							stdout = execResult.stdout;
						});
					},
				},
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
					environmentNames: ["EXT_ALLOWED"],
				}),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
			});
			try {
				await session.extensionRunner.emit({ type: "agent_start" });
				expect(stdout).toBe("sandboxed\n");
				expect(sandboxRequests).toHaveLength(1);
				expect(sandboxRequests[0]).toMatchObject({
					command: "definitely-not-a-host-command",
					args: ["--flag"],
				});
				expect(sandboxRequests[0]?.bindingId).toBeTruthy();
				expect(sandboxRequests[0]?.env).toEqual({ EXT_ALLOWED: "yes" });
				expect(JSON.stringify(session.getActiveExecutionPolicySummary())).not.toContain("EXT_SECRET");
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("disposes the old strict handle before a policy rebind and never reuses it", async () => {
			const firstSettings = executionPolicySettings({
				profileId: "strict-first",
				enforcement: "sandbox",
				sandboxProvider: "fake-sandbox",
			});
			const secondSettings = executionPolicySettings({
				profileId: "strict-second",
				enforcement: "sandbox",
				sandboxProvider: "fake-sandbox",
			});
			const fake = createFakeSandboxProvider({ onExecute: async () => ({ content: "sandboxed\n" }) });
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: {
					defaultProfile: "strict-first",
					profiles: { ...firstSettings.profiles, ...secondSettings.profiles },
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [fake.provider],
			});
			let hostCalls = 0;
			const hostOperations = {
				exec: async (): Promise<{ exitCode: number }> => {
					hostCalls++;
					return { exitCode: 0 };
				},
			};
			try {
				await session.executeBash("first", undefined, { operations: hostOperations });
				expect(fake.state.handles).toHaveLength(1);
				const firstHandleId = fake.state.handles[0]?.id;

				await session.setExecutionPolicyProfile("strict-second");
				expect(fake.state.disposedHandles).toEqual([firstHandleId]);

				await session.executeBash("second", undefined, { operations: hostOperations });
				expect(fake.state.handles).toHaveLength(2);
				expect(fake.state.invocations).toHaveLength(2);
				expect(fake.state.invocations[0]?.bindingId).not.toBe(fake.state.invocations[1]?.bindingId);
				expect(hostCalls).toBe(0);
			} finally {
				session.dispose();
				await session.waitForDispose();
				expect(fake.state.disposedHandles).toEqual(fake.state.handles.map((handle) => handle.id));
				expect(
					JSON.stringify(
						session.sessionManager
							.getEntries()
							.filter((entry) => entry.type === "custom" && entry.customType === "sandbox.lifecycle"),
					),
				).toContain('"status":"disposed"');
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("preserves allowed host extension ctx.exec result semantics", async () => {
			const extensionsResult = await createTestExtensionsResult([
				{
					name: "exec-tool",
					factory: (agent) => {
						agent.registerTool({
							name: "exec_helper",
							label: "exec_helper",
							description: "Extension exec helper",
							parameters: Type.Object({}),
							execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
								const result = await ctx.exec(process.execPath, [
									"-e",
									"process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
								]);
								return {
									content: [{ type: "text", text: JSON.stringify(result) }],
									details: result,
								};
							},
						});
					},
				},
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({ process: "allow" }),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
			});
			try {
				await session.whenCapabilitiesReady();
				const tool = session.agent.state.tools.find((candidate) => candidate.name === "exec_helper")!;
				const result = await tool.execute("exec-allow", {});
				expect(result.details).toEqual({ stdout: "out", stderr: "err", code: 7, killed: false });
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("authorizes MCP stdio startup before creating a transport", async () => {
			let factoryCalls = 0;
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({ process: "deny" }),
				mcp: { servers: { docs: { transport: "stdio", command: "node", env: ["SECRET_TOKEN"] } } },
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				mcpTransportFactory: (async () => {
					factoryCalls++;
					throw new Error("must never connect");
				}) as never,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({ code: "policy_denied" });
				expect(factoryCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("routes strict MCP stdio through the sandbox transport adapter with filtered env", async () => {
			const previousAllowed = process.env.MCP_ALLOWED_ENV;
			const previousSecret = process.env.MCP_SECRET_ENV;
			process.env.MCP_ALLOWED_ENV = "allowed-value";
			process.env.MCP_SECRET_ENV = "secret-value";
			let hostFactoryCalls = 0;
			const receivedCalls: Array<{ name: string; args: unknown }> = [];
			const mock = createMockMcpServer({
				tools: [{ name: "list", inputSchema: { type: "object" } }],
				receivedCalls,
			});
			const transportRequests: Array<Parameters<NonNullable<SandboxHandle["createMcpTransport"]>>[0]> = [];
			const handle: SandboxHandle = {
				id: "handle-stdio",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async () => ({ exitCode: 0 }),
				createMcpTransport: async (request) => {
					transportRequests.push(request);
					return mock.transportFactory({ id: request.serverId }) as never;
				},
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
					environmentNames: ["MCP_ALLOWED_ENV"],
				}),
				mcp: {
					servers: {
						docs: {
							transport: "stdio",
							command: "node",
							env: ["MCP_ALLOWED_ENV", "MCP_SECRET_ENV"],
						},
					},
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
				mcpTransportFactory: (async () => {
					hostFactoryCalls++;
					throw new Error("host transport must not be used");
				}) as never,
			});
			try {
				await session.whenCapabilitiesReady();
				expect(hostFactoryCalls).toBe(0);
				expect(transportRequests).toHaveLength(2);
				expect(transportRequests.every((request) => request.bindingId)).toBe(true);
				expect(transportRequests.every((request) => request.environment.MCP_ALLOWED_ENV === "allowed-value")).toBe(true);
				expect(transportRequests.every((request) => request.environment.MCP_SECRET_ENV === undefined)).toBe(true);
				expect(transportRequests.every((request) => Object.keys(request.headers).length === 0)).toBe(true);
				expect(transportRequests.every((request) => request.config.transport === "stdio" && request.config.command === "node")).toBe(true);
				const definition = session.getToolDefinition("mcp__docs__list")!;
				await definition.execute("call-1", {}, new AbortController().signal, undefined, {} as never);
				expect(receivedCalls).toEqual([{ name: "list", args: {} }]);
			} finally {
				if (previousAllowed === undefined) {
					delete process.env.MCP_ALLOWED_ENV;
				} else {
					process.env.MCP_ALLOWED_ENV = previousAllowed;
				}
				if (previousSecret === undefined) {
					delete process.env.MCP_SECRET_ENV;
				} else {
					process.env.MCP_SECRET_ENV = previousSecret;
				}
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails strict MCP closed before an injected host transport when the sandbox has no adapter", async () => {
			let hostFactoryCalls = 0;
			const handle: SandboxHandle = {
				id: "handle-no-mcp",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async () => ({ exitCode: 0 }),
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
				}),
				mcp: { servers: { docs: { transport: "stdio", command: "node" } } },
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
				mcpTransportFactory: (async () => {
					hostFactoryCalls++;
					throw new Error("host transport must not be used");
				}) as never,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "sandbox_capability_insufficient",
				});
				expect(hostFactoryCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails strict MCP network access closed before an injected host transport", async () => {
			let hostFactoryCalls = 0;
			const handle: SandboxHandle = {
				id: "handle-no-network",
				capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
				execute: async () => ({ exitCode: 0 }),
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
					network: "allow",
					networkApproval: "allow",
				}),
				mcp: { servers: { docs: { transport: "streamable-http", url: "https://mcp.example.invalid/mcp" } } },
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
				mcpTransportFactory: (async () => {
					hostFactoryCalls++;
					throw new Error("host transport must not be used");
				}) as never,
			});
			try {
				await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
					code: "sandbox_capability_insufficient",
				});
				expect(hostFactoryCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not fall back to parent environment values for host MCP stdio", async () => {
			const previousAllowed = process.env.MCP_ALLOWED_ENV;
			const previousSecret = process.env.MCP_SECRET_ENV;
			process.env.MCP_ALLOWED_ENV = "allowed-value";
			process.env.MCP_SECRET_ENV = "secret-value";
			const resolvedEnvironments: Array<{ allowed: string | undefined; secret: string | undefined }> = [];
			const mock = createMockMcpServer({
				tools: [{ name: "list", inputSchema: { type: "object" } }],
				receivedCalls: [],
			});
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					enforcement: "host",
					environmentNames: ["MCP_ALLOWED_ENV"],
				}),
				mcp: {
					servers: {
						docs: {
							transport: "stdio",
							command: "node",
							env: ["MCP_ALLOWED_ENV", "MCP_SECRET_ENV"],
						},
					},
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				mcpTransportFactory: (async (config: MCPServerConfig, env: MCPEnvResolver) => {
					resolvedEnvironments.push({
						allowed: env("MCP_ALLOWED_ENV"),
						secret: env("MCP_SECRET_ENV"),
					});
					return mock.transportFactory({ id: config.id }) as never;
				}) as never,
			});
			try {
				await session.whenCapabilitiesReady();
				expect(resolvedEnvironments).toHaveLength(2);
				expect(resolvedEnvironments).toEqual([
					{ allowed: "allowed-value", secret: undefined },
					{ allowed: "allowed-value", secret: undefined },
				]);
			} finally {
				if (previousAllowed === undefined) {
					delete process.env.MCP_ALLOWED_ENV;
				} else {
					process.env.MCP_ALLOWED_ENV = previousAllowed;
				}
				if (previousSecret === undefined) {
					delete process.env.MCP_SECRET_ENV;
				} else {
					process.env.MCP_SECRET_ENV = previousSecret;
				}
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it.each([
			{
				label: "deny",
				credentialAction: "deny",
				credentialApproval: "deny",
				expectedCode: "credential_policy_violation",
			},
			{
				label: "ask",
				credentialAction: "ask",
				credentialApproval: "ask",
				expectedCode: "policy_approval_required",
			},
			{
				label: "rejected",
				credentialAction: "allow",
				credentialApproval: "deny",
				expectedCode: "credential_policy_violation",
			},
		] as const)(
			"fails host MCP HTTP closed when header credential authorization resolves to $label",
			async ({ credentialAction, credentialApproval, expectedCode }) => {
				const previousAuth = process.env.MCP_AUTH_HEADER;
				process.env.MCP_AUTH_HEADER = "Bearer host-secret";
				let hostFactoryCalls = 0;
				const sessionSettings = SettingsManager.inMemory({
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
					executionPolicy: executionPolicySettings({
						networkApproval: "allow",
						credentialAction,
						credentialApproval,
						credentialNames: ["MCP_AUTH_HEADER"],
					}),
					mcp: {
						servers: {
							docs: {
								transport: "streamable-http",
								url: "https://mcp.example.invalid/mcp",
								headersFromEnv: [{ name: "Authorization", valueFromEnv: "MCP_AUTH_HEADER" }],
							},
						},
					},
				});
				const { session, dir } = await createControlledSession({
					resourceLoader: createTestResourceLoader(),
					settingsManager: sessionSettings,
					mcpTransportFactory: (async () => {
						hostFactoryCalls++;
						throw new Error("host transport must not be used");
					}) as never,
				});
				try {
					await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
						code: expectedCode,
					});
					expect(hostFactoryCalls).toBe(0);
				} finally {
					if (previousAuth === undefined) {
						delete process.env.MCP_AUTH_HEADER;
					} else {
						process.env.MCP_AUTH_HEADER = previousAuth;
					}
					session.dispose();
					if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				}
			},
		);

		it("passes allowed host MCP HTTP header credentials through the authorized resolver", async () => {
			const previousAuth = process.env.MCP_AUTH_HEADER;
			process.env.MCP_AUTH_HEADER = "Bearer host-secret";
			let hostFactoryCalls = 0;
			let resolvedCredential: string | undefined;
			const receivedCalls: Array<{ name: string; args: unknown }> = [];
			const mock = createMockMcpServer({
				tools: [{ name: "list", inputSchema: { type: "object" } }],
				receivedCalls,
			});
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					networkApproval: "allow",
					credentialNames: ["MCP_AUTH_HEADER"],
				}),
				mcp: {
					servers: {
						docs: {
							transport: "streamable-http",
							url: "https://mcp.example.invalid/mcp",
							headersFromEnv: [{ name: "Authorization", valueFromEnv: "MCP_AUTH_HEADER" }],
						},
					},
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				mcpTransportFactory: (async (config: MCPServerConfig, env: MCPEnvResolver) => {
					hostFactoryCalls++;
					resolvedCredential = env("MCP_AUTH_HEADER");
					return mock.transportFactory({ id: config.id }) as never;
				}) as never,
			});
			try {
				await session.whenCapabilitiesReady();
				expect(hostFactoryCalls).toBe(2);
				expect(resolvedCredential).toBe("Bearer host-secret");
				const definition = session.getToolDefinition("mcp__docs__list")!;
				await definition.execute("call-1", {}, new AbortController().signal, undefined, {} as never);
				expect(receivedCalls).toEqual([{ name: "list", args: {} }]);
			} finally {
				if (previousAuth === undefined) {
					delete process.env.MCP_AUTH_HEADER;
				} else {
					process.env.MCP_AUTH_HEADER = previousAuth;
				}
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("routes strict MCP HTTP through the sandbox adapter and redacts header credentials on failure", async () => {
			const previousAuth = process.env.MCP_AUTH_HEADER;
			process.env.MCP_AUTH_HEADER = "Bearer strict-secret";
			let hostFactoryCalls = 0;
			const transportRequests: Array<Parameters<NonNullable<SandboxHandle["createMcpTransport"]>>[0]> = [];
			const handle: SandboxHandle = {
				id: "handle-http",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async () => ({ exitCode: 0 }),
				createMcpTransport: async (request) => {
					transportRequests.push(request);
					throw new Error(`raw ${request.config.id} ${request.headers.Authorization}`);
				},
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const sessionSettings = SettingsManager.inMemory({
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
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
					networkApproval: "allow",
					credentialNames: ["MCP_AUTH_HEADER"],
				}),
				mcp: {
					servers: {
						docs: {
							transport: "streamable-http",
							url: "https://mcp.example.invalid/mcp",
							headersFromEnv: [{ name: "Authorization", valueFromEnv: "MCP_AUTH_HEADER" }],
						},
					},
				},
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
				mcpTransportFactory: (async () => {
					hostFactoryCalls++;
					throw new Error("host transport must not be used");
				}) as never,
			});
			try {
				let thrown: unknown;
				try {
					await session.whenCapabilitiesReady();
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toMatchObject({ code: "capability_mcp_connect_failed" });
				expect(hostFactoryCalls).toBe(0);
				expect(transportRequests).toHaveLength(1);
				expect(transportRequests[0]?.headers).toEqual({ Authorization: "Bearer strict-secret" });
				const rendered = `${JSON.stringify(thrown)}\n${inspect(thrown, { showHidden: true, depth: 5 })}`;
				expect(rendered).not.toContain("Bearer strict-secret");
				expect(rendered).not.toContain("Authorization");
			} finally {
				if (previousAuth === undefined) {
					delete process.env.MCP_AUTH_HEADER;
				} else {
					process.env.MCP_AUTH_HEADER = previousAuth;
				}
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("fails closed when strict sandbox policy has no real sandbox handle", async () => {
			let streamCalls = 0;
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "host-policy",
				}),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				onStreamCall: () => streamCalls++,
			});
			try {
				await expect(session.prompt("run")).rejects.toMatchObject({ code: "sandbox_unavailable" });
				expect(streamCalls).toBe(0);
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("routes user_bash through a strict sandbox handle when one is registered", async () => {
			const sandboxRequests: Array<{ command?: string; env?: NodeJS.ProcessEnv; bindingId?: string }> = [];
			let hostExecStarted = false;
			const handle: SandboxHandle = {
				id: "handle-1",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async (request) => {
					sandboxRequests.push({ command: request.command, env: request.env, bindingId: request.bindingId });
					request.onData?.(Buffer.from("sandboxed\n"));
					return { exitCode: 0 };
				},
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
				}),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader(),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
			});
			try {
				const result = await session.executeBash("echo ok", undefined, {
					id: "bash-sandbox",
					operations: {
						exec: async () => {
							hostExecStarted = true;
							return { exitCode: 0 };
						},
					},
				});
				expect(result.output).toBe("sandboxed\n");
				expect(hostExecStarted).toBe(false);
				expect(sandboxRequests).toHaveLength(1);
				expect(sandboxRequests[0]?.bindingId).toBeTruthy();
				expect(sandboxRequests[0]?.env?.PATH).toBeDefined();
				expect(sandboxRequests[0]?.env?.SECRET_TOKEN).toBeUndefined();
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not use extension bash results as strict sandbox host fallback", async () => {
			let extensionHandlerCalls = 0;
			let hostExecStarted = false;
			const sandboxRequests: Array<{ command?: string; bindingId?: string }> = [];
			const handle: SandboxHandle = {
				id: "handle-1",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async (request) => {
					sandboxRequests.push({ command: request.command, bindingId: request.bindingId });
					request.onData?.(Buffer.from("sandboxed\n"));
					return { exitCode: 0 };
				},
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: handle.capabilities,
				prepare: async () => handle,
				dispose: async () => {},
			};
			const extensionsResult = await createTestExtensionsResult([
				{
					name: "bash-interceptor",
					factory: (agent) => {
						agent.on("user_bash", async () => {
							extensionHandlerCalls++;
							return {
								result: {
									output: "host-extension\n",
									exitCode: 0,
									cancelled: false,
									truncated: false,
								},
							};
						});
					},
				},
			]);
			const sessionSettings = SettingsManager.inMemory({
				executionPolicy: executionPolicySettings({
					enforcement: "sandbox",
					sandboxProvider: "fake-sandbox",
				}),
			});
			const { session, dir } = await createControlledSession({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				settingsManager: sessionSettings,
				sandboxProviders: [provider],
			});
			try {
				let eventResult: Awaited<ReturnType<typeof session.extensionRunner.emitUserBash>> | undefined;
				if (await session.authorizeUserBashExtension("echo ok", { id: "bash-extension-sandbox" })) {
					eventResult = await session.extensionRunner.emitUserBash({
						type: "user_bash",
						command: "echo ok",
						excludeFromContext: false,
						cwd: session.sessionManager.getCwd(),
					});
				}
				const result = eventResult?.result ?? await session.executeBash("echo ok", undefined, {
					id: "bash-extension-sandbox-exec",
					operations: {
						exec: async () => {
							hostExecStarted = true;
							return { exitCode: 0 };
						},
					},
				});
				expect(result.output).toBe("sandboxed\n");
				expect(extensionHandlerCalls).toBe(0);
				expect(hostExecStarted).toBe(false);
				expect(sandboxRequests).toHaveLength(1);
				expect(sandboxRequests[0]?.bindingId).toBeTruthy();
			} finally {
				session.dispose();
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
