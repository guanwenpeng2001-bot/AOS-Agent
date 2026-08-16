import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "aos-rpc-client-mcp-content-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

type RpcClientPrivate = {
	send: (command: { type: string }, signal?: AbortSignal) => Promise<unknown>;
};

const RAW_URI = "file:///vault/secret-credential.txt";
const RAW_TEXT = "remote-credential-value";
const PROMPT_ARGS = { topic: "MCP" };

describe("RpcClient MCP content wire contract", () => {
	it("sends list/read/get/attach commands with pagination and parses receipts", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const sent: Array<{ type: string }> = [];
		const send = vi.fn(async (command: { type: string }, _signal?: AbortSignal) => {
			sent.push(command);
			switch (command.type) {
				case "mcp.resource.list":
					return {
						type: "response",
						command: "mcp.resource.list",
						success: true,
						data: {
							serverId: "docs",
							resources: [
								{
									resourceId: "resource-digest-1",
									serverId: "docs",
									name: "Guide",
									mimeType: "text/markdown",
									size: 10,
									provenanceId: "prov-1",
									revision: "rev-1",
								},
							],
							nextCursor: "page-2",
						},
					};
				case "mcp.resource.templates.list":
					return {
						type: "response",
						command: "mcp.resource.templates.list",
						success: true,
						data: {
							serverId: "docs",
							resourceTemplates: [
								{
									templateId: "template-digest-1",
									serverId: "docs",
									name: "doc-by-id",
									displayPattern: "https://example.com/x/{id}",
									uriTemplateDigest: "uri-template-digest",
									provenanceId: "prov-1",
									revision: "rev-1",
								},
							],
							nextCursor: "page-2",
						},
					};
				case "mcp.resource.read":
					return {
						type: "response",
						command: "mcp.resource.read",
						success: true,
						data: {
							serverId: "docs",
							resourceId: "resource-digest-1",
							blocks: [{ kind: "text", bytes: 22, digest: "block-digest" }],
							provenance: {
								serverId: "docs",
								source: "resource",
								sourceId: "resource-digest-1",
								contentDigest: "content-digest",
								byteCount: 22,
								blockCount: 1,
								untrusted: true,
								receivedAt: "2026-08-16T00:00:00.000Z",
							},
						},
					};
				case "mcp.resource.attach":
					return {
						type: "response",
						command: "mcp.resource.attach",
						success: true,
						data: {
							id: "attachment-digest",
							kind: "resource",
							serverId: "docs",
							sourceId: "resource-digest-1",
							provenance: {
								serverId: "docs",
								source: "resource",
								sourceId: "resource-digest-1",
								contentDigest: "content-digest",
								byteCount: 22,
								blockCount: 1,
								untrusted: true,
								receivedAt: "2026-08-16T00:00:00.000Z",
							},
							contentDigest: "content-digest",
							byteCount: 22,
							blockCount: 1,
							attachableBlockCount: 1,
							createdAt: "2026-08-16T00:00:00.000Z",
						},
					};
				case "mcp.prompt.list":
					return {
						type: "response",
						command: "mcp.prompt.list",
						success: true,
						data: {
							serverId: "docs",
							prompts: [
								{
									promptId: "prompt-digest-1",
									serverId: "docs",
									name: "summarize",
									description: "Summarize a topic",
									arguments: [],
									provenanceId: "prov-1",
									revision: "rev-1",
								},
							],
							nextCursor: "page-2",
						},
					};
				case "mcp.prompt.get":
					return {
						type: "response",
						command: "mcp.prompt.get",
						success: true,
						data: {
							serverId: "docs",
							promptId: "prompt-digest-1",
							messages: [
								{
									role: "user",
									blocks: [{ kind: "text", bytes: 16, digest: "block-digest" }],
									digest: "message-digest",
								},
							],
							provenance: {
								serverId: "docs",
								source: "prompt",
								sourceId: "prompt-digest-1",
								contentDigest: "content-digest",
								byteCount: 16,
								blockCount: 1,
								untrusted: true,
								receivedAt: "2026-08-16T00:00:00.000Z",
							},
						},
					};
				case "mcp.prompt.attach":
					return {
						type: "response",
						command: "mcp.prompt.attach",
						success: true,
						data: {
							id: "attachment-prompt-digest",
							kind: "prompt",
							serverId: "docs",
							sourceId: "prompt-digest-1",
							provenance: {
								serverId: "docs",
								source: "prompt",
								sourceId: "prompt-digest-1",
								contentDigest: "content-digest",
								byteCount: 16,
								blockCount: 1,
								untrusted: true,
								receivedAt: "2026-08-16T00:00:00.000Z",
							},
							contentDigest: "content-digest",
							byteCount: 16,
							blockCount: 1,
							attachableBlockCount: 1,
							createdAt: "2026-08-16T00:00:00.000Z",
						},
					};
				default:
					throw new Error(`unexpected command ${command.type}`);
			}
		});
		privateClient.send = send;

		const resources = await client.listMcpResources("docs", { cursor: "page-1" });
		expect(resources.resources[0].name).toBe("Guide");
		expect(resources.nextCursor).toBe("page-2");
		expect(sent[0]).toEqual({ type: "mcp.resource.list", serverId: "docs", cursor: "page-1" });

		const templates = await client.listMcpResourceTemplates("docs", { cursor: "page-1" });
		expect(templates.resourceTemplates[0]).toMatchObject({
			templateId: "template-digest-1",
			name: "doc-by-id",
			displayPattern: "https://example.com/x/{id}",
		});
		expect(templates.nextCursor).toBe("page-2");
		expect(sent[1]).toEqual({ type: "mcp.resource.templates.list", serverId: "docs", cursor: "page-1" });

		const read = await client.readMcpResource("docs", RAW_URI);
		expect(read.resourceId).toBe("resource-digest-1");
		expect(read.blocks[0]).toEqual({ kind: "text", bytes: 22, digest: "block-digest" });
		expect(sent[2]).toEqual({ type: "mcp.resource.read", serverId: "docs", uri: RAW_URI });
		expect(JSON.stringify(sent[2])).toContain(RAW_URI);
		expect(JSON.stringify(read)).not.toContain(RAW_URI);
		expect(JSON.stringify(read)).not.toContain(RAW_TEXT);

		const attach = await client.attachMcpResource("docs", RAW_URI);
		expect(attach.id).toBe("attachment-digest");
		expect(attach.kind).toBe("resource");
		expect(attach.attachableBlockCount).toBe(1);
		expect(JSON.stringify(attach)).not.toContain(RAW_URI);
		expect(JSON.stringify(attach)).not.toContain(RAW_TEXT);
		expect(sent[3]).toEqual({ type: "mcp.resource.attach", serverId: "docs", uri: RAW_URI });

		const prompts = await client.listMcpPrompts("docs");
		expect(prompts.prompts[0].name).toBe("summarize");
		expect(sent[4]).toEqual({ type: "mcp.prompt.list", serverId: "docs" });

		const gotten = await client.getMcpPrompt("docs", "summarize", PROMPT_ARGS);
		expect(gotten.promptId).toBe("prompt-digest-1");
		expect(sent[5]).toEqual({ type: "mcp.prompt.get", serverId: "docs", name: "summarize", args: PROMPT_ARGS });
		expect(JSON.stringify(gotten)).not.toContain("summarize");
		expect(JSON.stringify(gotten)).not.toContain("MCP");

		const promptAttach = await client.attachMcpPrompt("docs", "summarize", PROMPT_ARGS);
		expect(promptAttach.id).toBe("attachment-prompt-digest");
		expect(promptAttach.kind).toBe("prompt");
		expect(sent[6]).toEqual({ type: "mcp.prompt.attach", serverId: "docs", name: "summarize", args: PROMPT_ARGS });
		expect(JSON.stringify(promptAttach)).not.toContain("summarize");
		expect(JSON.stringify(promptAttach)).not.toContain("MCP");
	});

	it("surfaces the fixed content error code for a structured host failure", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: false,
			error: {
				code: "mcp_content_unsupported",
				message: 'MCP server "docs" returned unsupported content',
			},
		}));

		await expect(client.readMcpResource("docs", RAW_URI)).rejects.toMatchObject({
			name: "McpContentRpcError",
			code: "mcp_content_unsupported",
		});
	});

	it("surfaces a redacted host error for a failed command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: false,
			error: 'MCP server "missing" is not registered',
		}));

		await expect(client.readMcpResource("missing", RAW_URI)).rejects.toThrow('MCP server "missing" is not registered');
	});

	it("rejects the pending request when the caller signal aborts", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.on("data", () => {
	// Never respond: the caller must cancel the pending request.
});
process.stdin.resume();
`),
		});
		await client.start();

		const controller = new AbortController();
		const pending = client.readMcpResource("docs", RAW_URI, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort(new Error("caller cancelled"));
		await expect(pending).rejects.toThrow("caller cancelled");
		await client.stop();
	});
});
