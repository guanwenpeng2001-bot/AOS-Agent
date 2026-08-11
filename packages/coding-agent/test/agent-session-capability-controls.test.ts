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
import {
	CapabilityRegistry,
	type CapabilityCatalog,
	type CapabilityCatalogInput,
} from "../src/core/capability-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function tmpDir(name: string): { dir: string; agentDir: string } {
	const dir = join(tmpdir(), `pi-h2-controls-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ---------------------------------------------------------------------------
// In-memory MCP mock server (no real process or network).
// ---------------------------------------------------------------------------

const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(serverCleanups.splice(0).map((cleanup) => cleanup().catch(() => undefined)));
});

function createMockMcpServer(opts: { tools: Tool[]; receivedCalls: Array<{ name: string; args: unknown }> }): {
	transportFactory: (config: { id: string }) => Promise<unknown>;
} {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...opts.tools] }));
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

/** Registry that marks one descriptor unavailable so the approval guard can be tested. */
class UnavailableMarkingRegistry extends CapabilityRegistry {
	private readonly unavailableId: string;

	constructor(unavailableId: string) {
		super();
		this.unavailableId = unavailableId;
	}
	override buildCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
		const catalog = super.buildCatalog(input);
		return {
			version: 1,
			descriptors: catalog.descriptors.map((descriptor) =>
				descriptor.id === this.unavailableId
					? { ...descriptor, availability: "unavailable" as const }
					: descriptor,
			),
		};
	}
}

describe("AgentSession H2 session capability control", () => {
	const dualProfileSettings = {
		capabilities: {
			defaultProfile: "default",
			profiles: {
				default: {
					rules: [
						{ selector: { kind: "builtin_tool" }, action: "allow" },
						{ selector: { kind: "sdk_tool" }, action: "allow" },
					],
				},
				minimal: {
					rules: [
						{ selector: { kind: "builtin_tool" }, action: "allow" },
						{ selector: { id: "builtin_tool:builtin:read" }, action: "deny" },
						{ selector: { kind: "sdk_tool" }, action: "allow" },
					],
				},
			},
		},
	};

	it("materializes a nondefault profile into the actual binding and tool exposure", async () => {
		const { dir, agentDir } = tmpDir("profile-materialize");
		const settingsManager = SettingsManager.inMemory(dualProfileSettings);
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

			expect(session.getActiveCapabilityProfile()).toBe("default");
			expect(session.getActiveCapabilityBinding()?.profile).toBe("default");
			expect(session.getActiveToolNames()).toContain("read");

			await session.setCapabilityProfile("minimal");

			expect(session.getActiveCapabilityProfile()).toBe("minimal");
			const binding = session.getActiveCapabilityBinding()!;
			expect(binding.profile).toBe("minimal");
			expect(binding.toolAllowlist).not.toContain("read");
			expect(session.getActiveToolNames()).not.toContain("read");
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("read");
			expect(session.getActiveToolNames()).toContain("bash");
			expect(session.getActiveToolNames()).toContain("sdk_helper");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resets to settings.defaultProfile when the profile is omitted", async () => {
		const { dir, agentDir } = tmpDir("profile-reset");
		const settingsManager = SettingsManager.inMemory(dualProfileSettings);
		const sessionManager = SessionManager.inMemory(dir);
		try {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager,
			});
			await session.whenCapabilitiesReady();

			await session.setCapabilityProfile("minimal");
			expect(session.getActiveCapabilityProfile()).toBe("minimal");
			expect(session.getActiveToolNames()).not.toContain("read");

			await session.setCapabilityProfile();
			expect(session.getActiveCapabilityProfile()).toBe("default");
			expect(session.getActiveCapabilityBinding()?.profile).toBe("default");
			// The reset re-exposes read in the binding and registry, but does not
			// force a previously deselected builtin back into the active tool set.
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("read");
			expect(session.getAllTools().map((tool) => tool.name)).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("read");
			expect(session.getActiveToolNames()).toContain("bash");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws capability_profile_not_found for an unknown profile without falling back", async () => {
		const { dir, agentDir } = tmpDir("profile-unknown");
		const settingsManager = SettingsManager.inMemory(dualProfileSettings);
		const sessionManager = SessionManager.inMemory(dir);
		try {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager,
			});
			await session.whenCapabilitiesReady();

			await expect(session.setCapabilityProfile("missing")).rejects.toMatchObject({
				code: "capability_profile_not_found",
				profile: "missing",
			});
			// The active binding is untouched.
			expect(session.getActiveCapabilityBinding()?.profile).toBe("default");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reaches discovery readiness when the profile selects MCP servers", async () => {
		const { dir, agentDir } = tmpDir("profile-mcp");
		const receivedCalls: Array<{ name: string; args: unknown }> = [];
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: {
					default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] },
					mcp: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
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

			// The default profile does not select MCP servers.
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).not.toContain("mcp__docs__list");
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "configured" });

			// Materializing the mcp profile connects the selected server and
			// exposes its tools before setCapabilityProfile resolves.
			await session.setCapabilityProfile("mcp");

			expect(session.getActiveCapabilityBinding()?.profile).toBe("mcp");
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).toContain("mcp__docs__list");
			await expect(session.whenCapabilitiesReady()).resolves.toBeUndefined();
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exposes a redacted catalog view without server config details", async () => {
		const { dir, agentDir } = tmpDir("profile-inspect");
		const settingsManager = SettingsManager.inMemory({
			mcp: {
				servers: {
					docs: { transport: "stdio", command: "node" },
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

			const view = session.inspectCapabilityCatalog();
			const docs = view.descriptors.find((descriptor) => descriptor.id === "mcp_server:mcp:global:docs");
			expect(docs).toBeDefined();
			expect(docs!.decision).toBe("deny");
			expect(docs!.mcpServerId).toBe("docs");
			expect(session.inspectCapabilityCatalog().version).toBe(1);
			// Server config details (command/args/url/env names) never surface.
			const serialized = JSON.stringify(view);
			expect(serialized).not.toContain("node");
			expect(serialized).not.toContain("stdio");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("approves an ask capability session-locally and exposes it", async () => {
		const { dir, agentDir } = tmpDir("approve-ask");
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: {
					default: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { id: "sdk_tool:sdk:sdk_helper" }, action: "ask" },
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
				customTools: [sdkTool("sdk_helper")],
			});
			await session.whenCapabilitiesReady();

			const before = session.getActiveCapabilityBinding()!;
			expect(before.decisionSummary.awaitingApproval).toBeGreaterThan(0);
			expect(before.descriptors.some((ref) => ref.id === "sdk_tool:sdk:sdk_helper")).toBe(false);
			expect(session.getActiveToolNames()).not.toContain("sdk_helper");

			await session.approveCapability("sdk_tool:sdk:sdk_helper");

			const after = session.getActiveCapabilityBinding()!;
			expect(after.decisionSummary.awaitingApproval).toBe(0);
			expect(after.descriptors.some((ref) => ref.id === "sdk_tool:sdk:sdk_helper")).toBe(true);
			expect(after.toolAllowlist).toContain("sdk_helper");
			expect(session.getActiveToolNames()).toContain("sdk_helper");
			expect(session.getAllTools().map((tool) => tool.name)).toContain("sdk_helper");

			// Approving again is a no-op.
			await session.approveCapability("sdk_tool:sdk:sdk_helper");
			expect(session.getActiveCapabilityBinding()?.id).toBe(after.id);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not inherit a session-local ask approval into a fresh session with the same settings", async () => {
		const { dir, agentDir } = tmpDir("approve-not-inherited");
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: {
					default: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { id: "sdk_tool:sdk:sdk_helper" }, action: "ask" },
						],
					},
				},
			},
		});
		try {
			const first = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager: SessionManager.inMemory(dir),
				customTools: [sdkTool("sdk_helper")],
			});
			await first.session.whenCapabilitiesReady();
			expect(first.session.getActiveCapabilityBinding()!.decisionSummary.awaitingApproval).toBeGreaterThan(0);
			await first.session.approveCapability("sdk_tool:sdk:sdk_helper");
			expect(first.session.getActiveCapabilityBinding()!.decisionSummary.awaitingApproval).toBe(0);
			expect(first.session.getActiveCapabilityBinding()?.toolAllowlist).toContain("sdk_helper");
			expect(first.session.getActiveToolNames()).toContain("sdk_helper");

			// A fresh session built from the same settings (same in-memory manager
			// and catalog) must not inherit the approval: the ask capability starts
			// awaiting approval again and stays out of the binding until approved
			// independently in the new session.
			const second = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager: SessionManager.inMemory(dir),
				customTools: [sdkTool("sdk_helper")],
			});
			await second.session.whenCapabilitiesReady();

			const binding = second.session.getActiveCapabilityBinding()!;
			expect(binding.profile).toBe("default");
			expect(binding.decisionSummary.awaitingApproval).toBeGreaterThan(0);
			expect(binding.descriptors.some((ref) => ref.id === "sdk_tool:sdk:sdk_helper")).toBe(false);
			expect(binding.toolAllowlist).not.toContain("sdk_helper");
			expect(second.session.getActiveToolNames()).not.toContain("sdk_helper");
			expect(second.session.getAllTools().map((tool) => tool.name)).not.toContain("sdk_helper");

			// The fresh session can approve the same capability independently.
			await second.session.approveCapability("sdk_tool:sdk:sdk_helper");
			expect(second.session.getActiveCapabilityBinding()!.decisionSummary.awaitingApproval).toBe(0);
			expect(second.session.getActiveToolNames()).toContain("sdk_helper");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects approval of a denied descriptor", async () => {
		const { dir, agentDir } = tmpDir("approve-deny");
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] } },
			},
			mcp: {
				servers: {
					docs: { transport: "stdio", command: "node" },
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

			// An MCP server is deny by default and can never be enabled by approval.
			await expect(session.approveCapability("mcp_server:mcp:global:docs")).rejects.toMatchObject({
				code: "capability_denied",
			});
			expect(
				session.getActiveCapabilityBinding()?.descriptors.some(
					(ref) => ref.id === "mcp_server:mcp:global:docs",
				),
			).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects approval of an untrusted project descriptor", async () => {
		const { dir, agentDir } = tmpDir("approve-untrusted");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				capabilities: {
					defaultProfile: "default",
					profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] } },
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
		try {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager,
				mcpTransportFactory: (async () => {
					throw new Error("must never be called");
				}) as never,
			});
			await session.whenCapabilitiesReady();

			// An untrusted project MCP server is force-denied and cannot be approved.
			await expect(session.approveCapability("mcp_server:mcp:project:docs")).rejects.toMatchObject({
				code: "capability_denied",
			});
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects approval of a profile-denied descriptor", async () => {
		const { dir, agentDir } = tmpDir("approve-narrow");
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: {
					default: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { id: "builtin_tool:builtin:bash" }, action: "deny" },
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
			expect(session.getActiveToolNames()).not.toContain("bash");

			// The profile's deny rule wins even though the descriptor's baseline
			// decision is allow: approval cannot re-enable it.
			await expect(session.approveCapability("builtin_tool:builtin:bash")).rejects.toMatchObject({
				code: "capability_denied",
			});
			const binding = session.getActiveCapabilityBinding()!;
			expect(binding.descriptors.some((ref) => ref.id === "builtin_tool:builtin:bash")).toBe(false);
			expect(binding.toolAllowlist).not.toContain("bash");
			expect(session.getActiveToolNames()).not.toContain("bash");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects approval of an unavailable descriptor", async () => {
		const { dir, agentDir } = tmpDir("approve-unavailable");
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory(dir);
		const registry = new UnavailableMarkingRegistry("sdk_tool:sdk:sdk_helper");
		try {
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir,
				settingsManager,
				sessionManager,
				customTools: [sdkTool("sdk_helper")],
				capabilityRegistry: registry,
			});
			await session.whenCapabilitiesReady();

			await expect(session.approveCapability("sdk_tool:sdk:sdk_helper")).rejects.toMatchObject({
				code: "capability_denied",
			});
			expect(
				session.getActiveCapabilityBinding()?.descriptors.some(
					(ref) => ref.id === "sdk_tool:sdk:sdk_helper",
				),
			).toBe(false);
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defers profile materialization and ask approval while a run is active", async () => {
		const { dir, agentDir } = tmpDir("frozen-profile");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{ selector: { kind: "builtin_tool" }, action: "allow" },
								{ selector: { id: "sdk_tool:sdk:sdk_helper" }, action: "ask" },
							],
						},
						minimal: {
							rules: [
								{ selector: { kind: "builtin_tool" }, action: "allow" },
								{ selector: { id: "builtin_tool:builtin:read" }, action: "deny" },
								{ selector: { id: "sdk_tool:sdk:sdk_helper" }, action: "ask" },
							],
						},
					},
				},
			}),
		);
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
			customTools: [sdkTool("sdk_helper")],
		});
		try {
			const runPromise = session.prompt("First message");
			await waitUntil(() => session.isStreaming);

			const bindingBefore = session.getActiveCapabilityBinding()?.id;
			expect(session.getActiveCapabilityProfile()).toBe("default");
			expect(session.getActiveToolNames()).not.toContain("sdk_helper");

			// setCapabilityProfile and approveCapability block until the run
			// settles and must not mutate the frozen binding while it is active;
			// retain both promises and await them after the run is released.
			const profilePromise = session.setCapabilityProfile("minimal");
			const approvePromise = session.approveCapability("sdk_tool:sdk:sdk_helper");

			expect(session.getActiveCapabilityBinding()?.id).toBe(bindingBefore);
			expect(session.getActiveCapabilityBinding()?.profile).toBe("default");
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("sdk_helper");
			expect(session.isStreaming).toBe(true);

			releaseStream?.(createAssistantMessage("Done"));
			await runPromise;
			await profilePromise;
			await approvePromise;

			// Both operations materialized only after the run settled.
			expect(session.getActiveCapabilityProfile()).toBe("minimal");
			expect(session.getActiveCapabilityBinding()?.profile).toBe("minimal");
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("sdk_helper");
			expect(session.getActiveToolNames()).toContain("sdk_helper");
			expect(session.getActiveToolNames()).not.toContain("read");
		} finally {
			session.dispose();
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});
});
