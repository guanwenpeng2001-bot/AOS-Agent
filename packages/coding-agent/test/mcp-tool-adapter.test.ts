import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import type { AgentToolResult } from "@aos-agent/agent-core";
import {
	createMCPToolDefinition,
	createMCPToolMapping,
	filterMCPExposedToolNames,
	isMCPExposedToolName,
	mapMCPToolsToDefinitions,
	type MCPToolDefinitionResult,
	type MCPToolMappingOptions,
} from "../src/core/runtime/mcp-tool-adapter.ts";
import { CapabilityPublicIdentity } from "../src/core/policy/capability-public-identity.ts";
import { CapabilityRegistry } from "../src/core/policy/capability-registry.ts";
import { MCPError, type MCPCallResult } from "../src/core/runtime/mcp-types.ts";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
	return {
		name,
		description: `description for ${name}`,
		inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
		...overrides,
	};
}

const testAgentDir = mkdtempSync(join(tmpdir(), "aos-mcp-tool-adapter-"));
const registry = new CapabilityRegistry(CapabilityPublicIdentity.loadSync(testAgentDir));

afterAll(() => {
	rmSync(testAgentDir, { recursive: true, force: true });
});

const MAPPING: MCPToolMappingOptions = {
	serverId: "docs",
	sourceIdentity: "mcp:docs",
	parentDescriptorId: registry.createCapabilityId("mcp_server", "mcp:docs", "docs"),
	registry,
};

function caller(
	callTool: (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<MCPCallResult>,
) {
	return { ...MAPPING, callTool };
}

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
) => Promise<AgentToolResult<MCPCallResult>>;

function executeOf(def: MCPToolDefinitionResult): ExecuteFn {
	return def.definition.execute as unknown as ExecuteFn;
}

describe("createMCPToolMapping", () => {
	it("builds namespaced and stable capability identities from caller-provided identity", () => {
		const mapping = createMCPToolMapping(tool("list"), MAPPING);
		expect(mapping.exposedToolName).toBe("mcp__docs__list");
		expect(mapping.toolName).toBe("list");
		expect(mapping.serverId).toBe("docs");
		expect(mapping.sourceIdentity).toBe("mcp:docs");
		expect(mapping.parentDescriptorId).toBe(registry.createCapabilityId("mcp_server", "mcp:docs", "docs"));
		expect(mapping.descriptorId).toBe(registry.createCapabilityId("mcp_tool", "mcp:docs", "list"));
		expect(mapping.revisionInput).toEqual({
			name: "list",
			description: "description for list",
			inputSchema: {
				type: "object",
				properties: { q: { type: "string" } },
				required: ["q"],
			},
		});
	});

	it("matches a settings-layer parent descriptor id instead of hardcoding it", () => {
		const mapping = createMCPToolMapping(tool("list"), {
			serverId: "docs",
			sourceIdentity: "mcp:global:docs",
			parentDescriptorId: registry.createCapabilityId("mcp_server", "mcp:global:docs", "docs"),
			registry,
		});
		expect(mapping.parentDescriptorId).toBe(
			registry.createCapabilityId("mcp_server", "mcp:global:docs", "docs"),
		);
		expect(mapping.descriptorId).toBe(registry.createCapabilityId("mcp_tool", "mcp:global:docs", "list"));
	});

	it("keeps the revision input free of credentials", () => {
		const mapping = createMCPToolMapping(
			tool("list", {
				description: "list with token",
				inputSchema: {
					type: "object",
					properties: { token: { type: "string" }, q: { type: "string" } },
				},
			}),
			MAPPING,
		);
		expect(JSON.stringify(mapping.revisionInput)).not.toContain("secret");
		expect(mapping.descriptorId).toBe(registry.createCapabilityId("mcp_tool", "mcp:docs", "list"));
	});

	it("derives an opaque descriptor id when the internal source is an absolute path", () => {
		const sourceIdentity = "C:\\audit-private\\capability-source";
		const mapping = createMCPToolMapping(tool("list"), {
			...MAPPING,
			sourceIdentity,
			parentDescriptorId: registry.createCapabilityId("mcp_server", sourceIdentity, "docs"),
		});
		expect(mapping.descriptorId).toMatch(/^mcp_tool:source:/);
		expect(mapping.descriptorId).not.toContain("audit-private");
		expect(mapping.parentDescriptorId).not.toContain("audit-private");
	});

	it("rejects empty, double-underscore, whitespace, and colon segments", () => {
		expect(() => createMCPToolMapping(tool("list"), { ...MAPPING, serverId: "" })).toThrowError(MCPError);
		expect(() => createMCPToolMapping(tool("list"), { ...MAPPING, serverId: "a__b" })).toThrowError(
			/double underscore/,
		);
		expect(() => createMCPToolMapping(tool("list"), { ...MAPPING, serverId: "a b" })).toThrowError(MCPError);
		expect(() => createMCPToolMapping(tool("list"), { ...MAPPING, serverId: "a:b" })).toThrowError(MCPError);

		expect(() => createMCPToolMapping(tool(""), MAPPING)).toThrowError(MCPError);
		expect(() => createMCPToolMapping(tool("x__y"), MAPPING)).toThrowError(/double underscore/);
		expect(() => createMCPToolMapping(tool("x y"), MAPPING)).toThrowError(MCPError);
		expect(() => createMCPToolMapping(tool("x:y"), MAPPING)).toThrowError(MCPError);
	});
});

describe("createMCPToolDefinition", () => {
	it("exposes the tool under a namespaced name with the server schema", () => {
		const result = createMCPToolDefinition(tool("list"), caller(async () => ({ serverId: "docs", toolName: "list", content: [], isError: false })));
		expect(result.definition.name).toBe("mcp__docs__list");
		expect(result.definition.label).toBe("list");
		expect(result.definition.description).toBe("description for list");
		expect(JSON.stringify(result.definition.parameters)).toContain('"type":"object"');
		expect(JSON.stringify(result.definition.parameters)).toContain('"q"');
		expect(result.mapping.exposedToolName).toBe("mcp__docs__list");
	});

	it("returns text content on a successful call", async () => {
		const result = createMCPToolDefinition(
			tool("list"),
			caller(async () => ({
				serverId: "docs",
				toolName: "list",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
			})),
		);
		const executed = await executeOf(result)("call-1", { q: "x" }, undefined);
		expect(executed.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(executed.details).toMatchObject({ toolName: "list", isError: false });
	});

	it("throws a redacted call_failed error on isError without leaking remote text", async () => {
		const result = createMCPToolDefinition(
			tool("boom"),
			caller(async () => ({
				serverId: "docs",
				toolName: "boom",
				content: [{ type: "text", text: "boom remote details" }],
				isError: true,
			})),
		);
		let thrown: unknown;
		try {
			await executeOf(result)("call-1", {}, undefined);
			expect.unreachable("expected an error");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(MCPError);
		const mcpError = thrown as MCPError;
		expect(mcpError.kind).toBe("call_failed");
		expect(mcpError.serverId).toBe("docs");
		expect(mcpError.code).toBe("capability_mcp_unavailable");
		expect(mcpError.message).not.toContain("boom remote details");
		expect(JSON.stringify(mcpError)).not.toContain("boom remote details");
	});

	it("never lets remote error text or tokens escape the error message or JSON", async () => {
		const leakedText = "disk full sk-super-secret-token-12345";
		const result = createMCPToolDefinition(
			tool("boom"),
			caller(async () => ({
				serverId: "docs",
				toolName: "boom",
				content: [{ type: "text", text: leakedText }],
				isError: true,
			})),
		);
		let thrown: unknown;
		try {
			await executeOf(result)("call-1", {}, undefined);
			expect.unreachable("expected an error");
		} catch (error) {
			thrown = error;
		}
		const serialized = JSON.stringify(thrown);
		expect(String((thrown as Error).message)).not.toContain("sk-super-secret-token-12345");
		expect(serialized).not.toContain("sk-super-secret-token-12345");
		expect(serialized).not.toContain("disk full");
		expect(inspect(thrown, { showHidden: true, depth: 5 })).not.toContain("sk-super-secret-token-12345");
		expect(inspect(thrown, { showHidden: true, depth: 5 })).not.toContain("disk full");
	});

	it("converts image content and skips audio", async () => {
		const result = createMCPToolDefinition(
			tool("img"),
			caller(async () => ({
				serverId: "docs",
				toolName: "img",
				content: [
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
				],
				isError: false,
			})),
		);
		const executed = await executeOf(result)("call-1", {}, undefined);
		expect(executed.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	it("converts resource blocks to text or image", async () => {
		const result = createMCPToolDefinition(
			tool("res"),
			caller(async () => ({
				serverId: "docs",
				toolName: "res",
				content: [
					{ type: "resource", resource: { uri: "note://1", text: "note text" } },
					{ type: "resource", resource: { uri: "img://1", blob: "aGVsbG8=", mimeType: "image/png" } },
					{
						type: "resource",
						resource: { uri: "other://1", blob: "AAAA", mimeType: "application/octet-stream" },
					},
				],
				isError: false,
			})),
		);
		const executed = await executeOf(result)("call-1", {}, undefined);
		expect(executed.content).toEqual([
			{ type: "text", text: "note text" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});

	it("serializes structured content when there are no convertible blocks", async () => {
		const result = createMCPToolDefinition(
			tool("struct"),
			caller(async () => ({
				serverId: "docs",
				toolName: "struct",
				content: [],
				isError: false,
				structuredContent: { rows: [1, 2] },
			})),
		);
		const executed = await executeOf(result)("call-1", {}, undefined);
		expect(executed.content).toEqual([{ type: "text", text: '{"rows":[1,2]}' }]);
	});

	it("forwards the abort signal to the caller", async () => {
		let seenSignal: AbortSignal | undefined;
		const result = createMCPToolDefinition(
			tool("abort"),
			caller(async (_name, _args, signal) => {
				seenSignal = signal;
				return { serverId: "docs", toolName: "abort", content: [], isError: false };
			}),
		);
		const controller = new AbortController();
		await executeOf(result)("call-1", {}, controller.signal);
		expect(seenSignal).toBe(controller.signal);
	});

	it("rejects duplicate exposed names within one server instead of silently overwriting", () => {
		const opts = caller(async () => ({ serverId: "docs", toolName: "list", content: [], isError: false }));
		expect(() => mapMCPToolsToDefinitions([tool("list"), tool("list")], opts)).toThrowError(
			/Duplicate MCP tool exposed name/,
		);
		expect(() => mapMCPToolsToDefinitions([tool("list"), tool("list")], opts)).toThrowError(MCPError);
	});

	it("maps every discovered tool into a namespaced definition", () => {
		const opts = caller(async () => ({ serverId: "docs", toolName: "x", content: [], isError: false }));
		const results = mapMCPToolsToDefinitions([tool("list"), tool("status")], opts);
		expect(results.map((result) => result.definition.name)).toEqual([
			"mcp__docs__list",
			"mcp__docs__status",
		]);
	});
});

describe("MCP name filtering", () => {
	it("recognizes valid namespaced MCP tool names", () => {
		expect(isMCPExposedToolName("mcp__docs__list")).toBe(true);
		expect(isMCPExposedToolName("mcp__git__check-status")).toBe(true);
		expect(isMCPExposedToolName("read")).toBe(false);
		expect(isMCPExposedToolName("mcp__docs")).toBe(false);
		expect(isMCPExposedToolName("mcp____list")).toBe(false);
		expect(isMCPExposedToolName("mcp__docs__a__b")).toBe(false);
	});

	it("filters MCP-only names out of a mixed binding allowlist with builtins", () => {
		expect(
			filterMCPExposedToolNames(["read", "bash", "mcp__docs__list", "mcp__git__status", "write"]),
		).toEqual(["mcp__docs__list", "mcp__git__status"]);
		expect(filterMCPExposedToolNames(["read", "bash"])).toEqual([]);
	});
});
