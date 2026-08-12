import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
	handleLine: (line: string) => void;
};

function createClient(): { client: RpcClient; privateClient: RpcClientPrivate } {
	const client = new RpcClient();
	const privateClient = client as unknown as RpcClientPrivate;
	return { client, privateClient };
}

/**
 * A catalog descriptor shaped exactly like the redacted {@link CapabilityDescriptorView}:
 * only public metadata. No file paths, raw MCP config, env or header values, URL
 * credentials, tokens, or server instructions.
 */
function redactedDescriptor(): Record<string, unknown> {
	return {
		id: "mcp_tool:docs:read-file",
		revision: "rev:1a2b3c",
		kind: "mcp_tool",
		name: "Read File",
		source: { source: "docs", scope: "project", origin: "top-level" },
		availability: "available",
		decision: "allow",
		trusted: true,
		exposedToolName: "mcp__docs__read-file",
		parentId: "mcp_server:docs:docs",
		mcpServerId: "docs",
	};
}

describe("RpcClient get_capabilities request shapes", () => {
	it("getCapabilities() sends get_capabilities and parses catalog, binding, and bindings", async () => {
		const { client, privateClient } = createClient();
		const catalog = {
			version: 1,
			descriptors: [
				{
					id: "builtin_tool:core:read",
					revision: "rev:1",
					kind: "builtin_tool",
					name: "Read",
					source: { source: "core", scope: "user", origin: "top-level" },
					availability: "available",
					decision: "allow",
					trusted: true,
					exposedToolName: "Read",
				},
				redactedDescriptor(),
			],
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: { catalog, binding: null, bindings: [] },
		}));
		privateClient.send = send;

		const data = await client.getCapabilities();

		expect(send).toHaveBeenCalledWith({ type: "get_capabilities" });
		expect(data.catalog.version).toBe(1);
		expect(data.catalog.descriptors).toHaveLength(2);
		expect(data.catalog.descriptors.map((descriptor) => descriptor.id)).toEqual([
			"builtin_tool:core:read",
			"mcp_tool:docs:read-file",
		]);
		expect(data.binding).toBeNull();
		expect(data.bindings).toEqual([]);
	});

	it("getCapabilities surfaces only the redacted catalog fields", async () => {
		const { client, privateClient } = createClient();
		const catalog = { version: 1, descriptors: [redactedDescriptor()] };
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: { catalog, binding: null, bindings: [] },
		}));
		privateClient.send = send;

		const data = await client.getCapabilities();

		expect(data.catalog.version).toBe(1);
		expect(data.catalog.descriptors).toHaveLength(1);
		const parsed = data.catalog.descriptors[0];

		// The parsed payload exposes exactly the public redacted fields.
		expect(Object.keys(parsed).sort()).toEqual(
			[
				"id",
				"revision",
				"kind",
				"name",
				"source",
				"availability",
				"decision",
				"trusted",
				"exposedToolName",
				"parentId",
				"mcpServerId",
			].sort(),
		);

		// The redacted source is exactly { source, scope, origin }.
		expect(Object.keys(parsed.source).sort()).toEqual(["origin", "scope", "source"]);
		expect(parsed.source).toEqual({ source: "docs", scope: "project", origin: "top-level" });

		// No secret-shaped keys or values anywhere in the serialized catalog:
		// no file paths, env/header values, URL credentials or query, tokens,
		// raw MCP config, or server instructions.
		const serialized = JSON.stringify(data.catalog);
		for (const leaked of ["path", "env", "url", "token", "config", "instructions"]) {
			expect(serialized).not.toContain(leaked);
		}
	});

	it("getCapabilities(bindingId) sends the binding id and returns the single requested binding", async () => {
		const { client, privateClient } = createClient();
		const view = {
			id: "binding:default:abc123",
			profile: "default",
			createdAt: "2026-01-01T00:00:00.000Z",
			descriptors: [{ id: "builtin_tool:core:read", revision: "rev:1", exposedToolName: "Read" }],
			decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
			toolAllowlist: ["Read"],
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: { binding: view, bindings: [] },
		}));
		privateClient.send = send;

		const data = await client.getCapabilities("binding:default:abc123");

		expect(send).toHaveBeenCalledWith({ type: "get_capabilities", bindingId: "binding:default:abc123" });
		expect(data.binding?.id).toBe("binding:default:abc123");
		expect(data.binding?.profile).toBe("default");
		expect(data.binding?.toolAllowlist).toEqual(["Read"]);
		expect(data.bindings).toEqual([]);
	});
});

describe("RpcClient get_capabilities failures", () => {
	it("rejects with a plain Error whose message contains the server's string failure", async () => {
		const { client, privateClient } = createClient();
		privateClient.send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: false,
			error: "Capability binding not found: binding:ghost",
		}));

		const promise = client.getCapabilities("binding:ghost");

		await expect(promise).rejects.toBeInstanceOf(Error);
		await expect(promise).rejects.toThrow("Capability binding not found");
	});
});
