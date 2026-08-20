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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types";
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
	const dir = join(tmpdir(), `aos-h2-controls-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	return {
		transportFactory: async () => {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });

			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...opts.tools] }));
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

/**
 * Like {@link createMockMcpServer}, but creates a fresh in-memory server and
 * transport pair on every factory call, so a server reconnected after a
 * profile deselection gets a brand-new transport instead of reusing one that
 * was already closed. Tracks how many transports were created so the test can
 * assert an explicit reconnect really built a fresh connection.
 */
function createReconnectableMcpServer(opts: { tools: Tool[]; receivedCalls: Array<{ name: string; args: unknown }> }): {
	transportFactory: (config: { id: string }) => Promise<unknown>;
	factoryCallCount: () => number;
} {
	let factoryCalls = 0;
	return {
		transportFactory: (async () => {
			factoryCalls += 1;
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...opts.tools] }));
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
		}) as never,
		factoryCallCount: () => factoryCalls,
	};
}

/**
 * Transport wrapper that gates the underlying transport's `close()` behind a
 * manually released per-transport gate. `close()` records its invocation (so a
 * test can deterministically wait for a teardown to start) and then parks on
 * the gate before delegating to the underlying close, making an in-flight
 * teardown observable and controllable without any sleeps. All other members
 * delegate to the underlying transport, so it behaves transparently until a
 * close is requested.
 */
class GatedCloseTransport {
	private readonly underlying: InMemoryTransport;
	private _closeInvoked = false;
	private _closeCalls = 0;
	private readonly gate: Promise<void>;
	private releaseGate: () => void = () => undefined;

	constructor(underlying: InMemoryTransport) {
		this.underlying = underlying;
		this.gate = new Promise<void>((resolve) => {
			this.releaseGate = resolve;
		});
	}

	start(): Promise<void> {
		return this.underlying.start();
	}

	send(message: JSONRPCMessage, options?: Parameters<InMemoryTransport["send"]>[1]): Promise<void> {
		return this.underlying.send(message, options);
	}

	close(): Promise<void> {
		this._closeCalls += 1;
		this._closeInvoked = true;
		return this.gate.then(() => this.underlying.close());
	}

	get onclose(): (() => void) | undefined {
		return this.underlying.onclose;
	}
	set onclose(handler: (() => void) | undefined) {
		this.underlying.onclose = handler;
	}
	get onerror(): ((error: Error) => void) | undefined {
		return this.underlying.onerror;
	}
	set onerror(handler: ((error: Error) => void) | undefined) {
		this.underlying.onerror = handler;
	}
	get onmessage(): NonNullable<InMemoryTransport["onmessage"]> | undefined {
		return this.underlying.onmessage;
	}
	set onmessage(handler: NonNullable<InMemoryTransport["onmessage"]> | undefined) {
		this.underlying.onmessage = handler;
	}
	get sessionId(): string | undefined {
		return this.underlying.sessionId;
	}
	set sessionId(value: string | undefined) {
		this.underlying.sessionId = value;
	}
	setProtocolVersion(version: string): void {
		(this.underlying as Transport).setProtocolVersion?.(version);
	}

	closeInvoked(): boolean {
		return this._closeInvoked;
	}

	closeCalls(): number {
		return this._closeCalls;
	}

	release(): void {
		this.releaseGate();
	}

	/** Fires the chained onclose handler as if the transport closed out-of-band. */
	fireLateOnclose(): void {
		this.underlying.onclose?.();
	}
}

/**
 * Like {@link createReconnectableMcpServer}, but wraps every created client
 * transport in a {@link GatedCloseTransport}, so a test can hold a teardown's
 * transport close open and race a re-selection against it deterministically.
 */
function createGatedCloseMcpServer(opts: {
	tools: Tool[];
	receivedCalls: Array<{ name: string; args: unknown }>;
}): {
	transportFactory: (config: { id: string }) => Promise<unknown>;
	factoryCallCount: () => number;
	transports: () => GatedCloseTransport[];
} {
	let factoryCalls = 0;
	const transports: GatedCloseTransport[] = [];
	return {
		transportFactory: (async () => {
			factoryCalls += 1;
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...opts.tools] }));
			server.setRequestHandler(CallToolRequestSchema, async (request) => {
				opts.receivedCalls.push({ name: request.params.name, args: request.params.arguments });
				return { content: [{ type: "text", text: `ok:${request.params.name}` }] };
			});
			server.connect(serverTransport).catch(() => undefined);
			serverCleanups.push(async () => {
				await server.close().catch(() => undefined);
				await clientTransport.close().catch(() => undefined);
			});
			const gated = new GatedCloseTransport(clientTransport);
			transports.push(gated);
			return gated;
		}) as never,
		factoryCallCount: () => factoryCalls,
		transports: () => [...transports],
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
				descriptor.exposedToolName === this.unavailableId
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

	it("closes a deselected MCP server when a profile change drops it", async () => {
		const { dir, agentDir } = tmpDir("profile-close");
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
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "configured" });

			await session.setCapabilityProfile("mcp");
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });

			// Deselecting the server via the profile awaits the lifecycle teardown
			// before setCapabilityProfile resolves: no stale live connection or
			// stale selection survives the transition.
			await session.setCapabilityProfile("default");
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "closed" });
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).not.toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).not.toContain("mcp__docs__list");
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reconnects a re-selected MCP server with a fresh transport after a profile drop", async () => {
		const { dir, agentDir } = tmpDir("profile-reconnect");
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
		const mock = createReconnectableMcpServer({
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

			// First materialization discovers tools under a pre-discovery binding,
			// then reconnects once under the final binding that includes those tools.
			expect(mock.factoryCallCount()).toBe(0);
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "configured" });

			await session.setCapabilityProfile("mcp");
			expect(mock.factoryCallCount()).toBe(2);
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).toContain("mcp__docs__list");

			// Dropping the profile closes the old transport exactly once before
			// the transition resolves; no stale live connection survives.
			await session.setCapabilityProfile("default");
			expect(mock.factoryCallCount()).toBe(2);
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "closed" });
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).not.toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).not.toContain("mcp__docs__list");

			// Re-selecting the profile triggers a fresh explicit discovery/connect
			// with a brand-new transport (the closed one is never reused), and the
			// server returns to ready without a close/reselect race.
			await session.setCapabilityProfile("mcp");
			expect(mock.factoryCallCount()).toBe(4);
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).toContain("mcp__docs__list");
			await expect(session.whenCapabilitiesReady()).resolves.toBeUndefined();

			// The reconnected tool still routes calls through the fresh server.
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

	it("makes a concurrent profile re-selection latest-invoked-wins while the old transport close is pending", async () => {
		const { dir, agentDir } = tmpDir("profile-race");
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
		const mock = createGatedCloseMcpServer({
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

			// First materialization discovers tools, then reconnects under the final
			// binding. Release the discovery transport's gated close before awaiting
			// the transition so the final transport can be installed.
			const initialProfile = session.setCapabilityProfile("mcp");
			await waitUntil(() => mock.transports()[0]?.closeInvoked() === true);
			mock.transports()[0]?.release();
			await initialProfile;
			expect(mock.factoryCallCount()).toBe(2);
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			const firstTransport = mock.transports()[1]!;

			// Deselect the server, but hold its transport close open: the transition
			// parks mid-teardown and cannot complete until the gate is released.
			const p1 = session.setCapabilityProfile("default");
			await waitUntil(() => firstTransport.closeInvoked());

			// A re-selection invoked while the old close is pending must win. On the
			// unfixed HEAD it raced the pending close and rejected as unavailable.
			const p2 = session.setCapabilityProfile("mcp");
			firstTransport.release();
			await waitUntil(() => mock.transports()[2]?.closeInvoked() === true);
			mock.transports()[2]?.release();
			const [settled1, settled2] = await Promise.allSettled([p1, p2]);
			expect(settled1.status).toBe("fulfilled");
			expect(settled2.status).toBe("fulfilled");

			// Latest-invoked profile wins deterministically (default completes the
			// deselection; mcp completes the re-selection).
			expect(session.getActiveCapabilityProfile()).toBe("mcp");
			expect(session.getActiveCapabilityBinding()?.profile).toBe("mcp");
			// The old transport is torn down exactly once, and a fresh transport
			// is created for the re-selected connect.
			expect(firstTransport.closeCalls()).toBe(1);
			expect(mock.factoryCallCount()).toBe(4);
			// A fresh connection is ready with the re-selected server's tools.
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({
				state: "ready",
				availability: "available",
			});
			expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");
			expect(session.getActiveToolNames()).toContain("mcp__docs__list");
			await expect(session.whenCapabilitiesReady()).resolves.toBeUndefined();

			// The fresh transport serves calls.
			const definition = session.getToolDefinition("mcp__docs__list")!;
			const execute = definition.execute as unknown as (
				toolCallId: string,
				params: Record<string, unknown>,
				signal?: AbortSignal,
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
			const result = await execute("call-race-1", { q: 1 }, undefined);
			expect(result.content).toContainEqual({ type: "text", text: "ok:list" });
			expect(receivedCalls).toContainEqual({ name: "list", args: { q: 1 } });

			// A late onclose from the old transport cannot degrade the fresh connection.
			firstTransport.fireLateOnclose();
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });
			const resultAfterLateClose = await execute("call-race-2", { q: 2 }, undefined);
			expect(resultAfterLateClose.content).toContainEqual({ type: "text", text: "ok:list" });
		} finally {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("closes a previously selected MCP server when a profile transition fails closed", async () => {
		const { dir, agentDir } = tmpDir("profile-fail-closed");
		const receivedCalls: Array<{ name: string; args: unknown }> = [];
		const settingsManager = SettingsManager.inMemory({
			capabilities: {
				defaultProfile: "default",
				profiles: {
					// sdk_tool is explicitly denied outside the conflict profile so
					// the SDK "read" collision only surfaces when it is materialized.
					default: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { kind: "sdk_tool" }, action: "deny" },
						],
					},
					mcp: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { kind: "sdk_tool" }, action: "deny" },
							{ selector: { kind: "mcp_server" }, action: "allow" },
							{ selector: { kind: "mcp_tool" }, action: "allow" },
						],
					},
					// Selects the MCP server AND collides on the exposed "read"
					// name (builtin read + SDK read), so materialization cannot
					// resolve the binding.
					conflict: {
						rules: [
							{ selector: { kind: "builtin_tool" }, action: "allow" },
							{ selector: { kind: "sdk_tool" }, action: "allow" },
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
				customTools: [sdkTool("read")],
				mcpTransportFactory: mock.transportFactory as never,
			});
			await session.whenCapabilitiesReady();

			await session.setCapabilityProfile("mcp");
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "ready" });

			// The conflict profile cannot resolve: the transition must fail
			// closed and close/deselect the previously selected server before the
			// conflict surfaces. It must NOT roll back by re-selecting the old MCP.
			await expect(session.setCapabilityProfile("conflict")).rejects.toMatchObject({
				code: "capability_name_conflict",
			});

			// No stale selected/ready server remains after the failed transition.
			expect(session.getMcpConnectionStatus("docs")).toMatchObject({ state: "closed" });
			expect(session.getMcpConnectionStatus("docs")?.state).not.toBe("ready");
			expect(session.getActiveCapabilityBinding()).toBeUndefined();
			await expect(session.whenCapabilitiesReady()).rejects.toMatchObject({
				code: "capability_name_conflict",
			});
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
			const docs = view.descriptors.find(
				(descriptor) => descriptor.kind === "mcp_server" && descriptor.mcpServerId === "docs",
			);
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
			expect(after.descriptors.some((ref) => ref.exposedToolName === "sdk_helper")).toBe(true);
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
		const registry = new UnavailableMarkingRegistry("sdk_helper");
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
			await session.whenCapabilitiesReady();
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
			await session.abort();
			session.dispose();
			await session.waitForDispose();
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});
});
