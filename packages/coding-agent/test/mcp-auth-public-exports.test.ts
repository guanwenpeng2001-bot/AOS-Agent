import { describe, expect, it } from "vitest";
import * as packageEntry from "../src/index.ts";
import {
	McpAuthRpcError,
	McpContentRpcError,
	RpcClient,
	type MCPAuthCallbackMode,
	type MCPAuthStartOptions,
	type MCPAuthStartResult,
	type RpcMcpAuthInteraction,
	type RpcMcpAuthInteractiveOptions,
} from "../src/index.ts";

describe("MCP OAuth interactive public entry exports", () => {
	it("exposes the interactive bridge through the package entry without starting a process or socket", () => {
		// Value exports: the client and the documented rejection classes.
		expect(typeof RpcClient).toBe("function");
		expect(typeof McpAuthRpcError).toBe("function");
		expect(typeof McpContentRpcError).toBe("function");
		// Constructing a client never spawns a child process or opens a socket;
		// start() is the only method that does.
		const client = new RpcClient();
		expect(typeof client.startMcpAuthInteractive).toBe("function");
		expect(typeof client.getMcpAuthStatus).toBe("function");
	});

	it("keeps the interactive bridge types type-safe for extension-UI callers", () => {
		// Type-only exports are erased at runtime; the compile-time imports
		// above are the static verification. Construction stays side-effect
		// free: no transport, no dialogs, no flow, no network.
		const interaction: RpcMcpAuthInteraction = {
			onAuthUrl: (url: string, instructions?: string) => {
				expect(url.length).toBeGreaterThan(0);
				expect(instructions).toBeUndefined();
			},
			confirm: () => true,
			inputCode: () => "code",
		};
		const options: RpcMcpAuthInteractiveOptions = {
			callbackMode: "loopback",
			timeoutMs: 1_000,
			requestTimeoutMs: 500,
			signal: new AbortController().signal,
		};
		expect(interaction.confirm?.("consent?")).toBe(true);
		expect(interaction.inputCode?.("code?", "placeholder")).toBe("code");
		expect(options.callbackMode).toBe("loopback");
		expect(options.signal?.aborted).toBe(false);
	});

	it("types the AgentSession.startMcpAuth options and result without secrets", () => {
		const startOptions: MCPAuthStartOptions = {
			interaction: {
				prompt: async () => "confirmed",
				notify: () => undefined,
			},
			callbackMode: "https",
			httpsCallbackUrl: "https://127.0.0.1:8080/callback",
			timeoutMs: 1_000,
			requestTimeoutMs: 500,
		};
		const loopbackMode: MCPAuthCallbackMode = "loopback";
		const result: MCPAuthStartResult = { status: "authorized" };
		expect(startOptions.callbackMode).toBe("https");
		expect(startOptions.interaction).toBeDefined();
		expect(loopbackMode).toBe("loopback");
		expect(result.status).toBe("authorized");
	});

	it("keeps the internal OAuth implementation classes out of the public entry", () => {
		expect("MCPAuthManager" in packageEntry).toBe(false);
		expect("MCPAuthFlow" in packageEntry).toBe(false);
		expect("MCPServerOAuthProvider" in packageEntry).toBe(false);
	});
});
