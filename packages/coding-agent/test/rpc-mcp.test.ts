import { describe, expect, it, vi } from "vitest";
import { CapabilityError } from "../src/core/capability-registry.ts";
import { PolicyError } from "../src/core/execution-policy.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { MCPAuthError } from "../src/core/mcp-auth.ts";
import { MCPError } from "../src/core/mcp-types.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { RpcHostController, type RpcHostOutputRecord } from "../src/modes/rpc/rpc-host.ts";
import type { RpcAutomationResponse, RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";

const AUTH_URL = "https://auth.example.test/authorize?client_id=abc&code_challenge=xyz";
const RESOURCE_ID = "mcp-res-1111111111111111";
const PROMPT_ID = "mcp-prompt-1111111111111111";
const TEMPLATE_ID = "mcp-tpl-1111111111111111";

/** Canonical MCP public surface command set advertised by initialize. */
const MCP_COMMANDS = [
	"mcp.list_resources",
	"mcp.list_resource_templates",
	"mcp.read_resource",
	"mcp.attach_resource",
	"mcp.list_prompts",
	"mcp.get_prompt",
	"mcp.attach_prompt",
	"mcp.auth.start",
	"mcp.auth.logout",
] as const;

interface FakeSession {
	agent: { subscribe: ReturnType<typeof vi.fn> };
	subscribe: ReturnType<typeof vi.fn>;
	bindExtensions: ReturnType<typeof vi.fn>;
	sessionId: string;
	sessionManager: {
		getSessionId: ReturnType<typeof vi.fn>;
		getSessionFile: ReturnType<typeof vi.fn>;
		appendCustomEntry: ReturnType<typeof vi.fn>;
		getEntries: ReturnType<typeof vi.fn>;
	};
	listMcpResources: ReturnType<typeof vi.fn>;
	listMcpResourceTemplates: ReturnType<typeof vi.fn>;
	readMcpResource: ReturnType<typeof vi.fn>;
	attachMcpResource: ReturnType<typeof vi.fn>;
	listMcpPrompts: ReturnType<typeof vi.fn>;
	getMcpPrompt: ReturnType<typeof vi.fn>;
	attachMcpPrompt: ReturnType<typeof vi.fn>;
	startMcpAuth: ReturnType<typeof vi.fn>;
	waitForMcpAuth: ReturnType<typeof vi.fn>;
	logoutMcpAuth: ReturnType<typeof vi.fn>;
	getMcpAuthStatus: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	steer: ReturnType<typeof vi.fn>;
	followUp: ReturnType<typeof vi.fn>;
}

function createFakeSession(): FakeSession {
	const session: FakeSession = {
		agent: { subscribe: vi.fn(() => () => {}) },
		subscribe: vi.fn(() => () => {}),
		bindExtensions: vi.fn(async () => {}),
		sessionId: "session-1",
		sessionManager: {
			getSessionId: vi.fn(() => "session-1"),
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			appendCustomEntry: vi.fn(() => "entry-1"),
			getEntries: vi.fn(() => []),
		},
		listMcpResources: vi.fn(async () => ({
			items: [
				{
					serverId: "docs",
					resourceId: RESOURCE_ID,
					name: "Guide",
					mimeType: "text/markdown",
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		})),
		listMcpResourceTemplates: vi.fn(async () => ({
			items: [
				{
					serverId: "docs",
					templateId: TEMPLATE_ID,
					name: "note template",
					mimeType: "text/plain",
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		})),
		readMcpResource: vi.fn(async () => ({
			serverId: "docs",
			resourceId: RESOURCE_ID,
			content: {
				blocks: [{ type: "text", text: "guide text" }],
				truncated: false,
				unsafe: false,
				droppedBlocks: 0,
				droppedBytes: 0,
				byteCount: 10,
			},
			byteCount: 10,
			truncated: false,
			provenanceId: "mcp-content-1111111111111111",
			revision: "rev:1111111111111111",
		})),
		attachMcpResource: vi.fn(async () => ({
			attachmentId: "source-resource",
			serverId: "docs",
			contentLength: 10,
			truncated: false,
		})),
		listMcpPrompts: vi.fn(async () => ({
			items: [
				{
					serverId: "docs",
					promptId: PROMPT_ID,
					name: "summarize",
					description: "Summarize a topic",
					arguments: [{ name: "threadId", required: true }],
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		})),
		getMcpPrompt: vi.fn(async () => ({
			serverId: "docs",
			promptId: PROMPT_ID,
			messages: [
				{
					role: "user",
					content: {
						blocks: [{ type: "text", text: "please summarize" }],
						truncated: false,
						unsafe: false,
						droppedBlocks: 0,
						droppedBytes: 0,
						byteCount: 16,
					},
				},
			],
			provenanceId: "mcp-content-1111111111111111",
			revision: "rev:1111111111111111",
		})),
		attachMcpPrompt: vi.fn(async () => ({
			attachmentId: "source-prompt",
			serverId: "docs",
			contentLength: 15,
			truncated: false,
		})),
		startMcpAuth: vi.fn(async () => ({
			outcome: "interaction_required",
			status: { serverId: "docs", state: "interaction_required" },
			authorizationUrl: AUTH_URL,
		})),
		waitForMcpAuth: vi.fn(async () => ({
			outcome: "authorized",
			status: { serverId: "docs", state: "authenticated" },
		})),
		logoutMcpAuth: vi.fn(async () => {}),
		getMcpAuthStatus: vi.fn(async () => ({
			serverId: "docs",
			authSupported: true,
			auth: { serverId: "docs", state: "interaction_required" },
			credential: {
				serverId: "docs",
				hasCredential: false,
				status: "none",
				expiresAt: 0,
				scopes: [],
				revision: 0,
			},
		})),
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
	};
	return session;
}

interface Harness {
	controller: RpcHostController;
	session: FakeSession;
	records: RpcHostOutputRecord[];
	dispatch: (command: RpcCommand) => Promise<RpcResponse | RpcAutomationResponse | undefined>;
	cleanup: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const session = createFakeSession();
	const runtimeHost = {
		session,
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, {
		output: {
			publish: (record: RpcHostOutputRecord) => {
				records.push(record);
			},
		},
	});
	await controller.start();
	return {
		controller,
		session,
		records,
		dispatch: (command) => controller.dispatch(command),
		cleanup: async () => {
			await controller.shutdown().catch(() => undefined);
		},
	};
}

function successData<T>(response: RpcResponse | RpcAutomationResponse | undefined, command: string): T {
	expect(response).toMatchObject({ type: "response", command, success: true });
	return (response as unknown as { data: T }).data;
}

describe("RPC MCP public surface (mcp.list/read/attach_resources, mcp.list/get/attach_prompts, mcp.auth.*)", () => {
	it("advertises the canonical MCP command set on initialize", async () => {
		const { controller, cleanup } = await createHarness();
		try {
			const data = successData<{ mcpCommands: string[] }>(
				await controller.dispatch({ type: "initialize", protocolVersion: 1 }),
				"initialize",
			);
			expect(data.mcpCommands).toEqual(MCP_COMMANDS);
		} finally {
			await cleanup();
		}
	});

	it("routes list/read/get commands to the Session MCP methods without starting a run", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			const list = successData(await controller.dispatch({ type: "mcp.list_resources", serverId: "docs" }), "mcp.list_resources");
			expect(list).toMatchObject({ truncated: false });
			expect(session.listMcpResources).toHaveBeenCalledWith("docs", undefined);

			const templates = successData(
				await controller.dispatch({ type: "mcp.list_resource_templates", serverId: "docs" }),
				"mcp.list_resource_templates",
			);
			expect(templates).toMatchObject({ truncated: false });
			expect(session.listMcpResourceTemplates).toHaveBeenCalledWith("docs", undefined);

			const templatesCursor = await controller.dispatch({
				type: "mcp.list_resource_templates",
				serverId: "docs",
				cursor: "tpl-2",
			});
			expect(session.listMcpResourceTemplates).toHaveBeenLastCalledWith("docs", "tpl-2");
			expect(templatesCursor).toMatchObject({ success: true });

			const listCursor = await controller.dispatch({ type: "mcp.list_resources", serverId: "docs", cursor: "page-2" });
			expect(session.listMcpResources).toHaveBeenLastCalledWith("docs", "page-2");
			expect(listCursor).toMatchObject({ success: true });

			const read = successData(await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID }), "mcp.read_resource");
			expect(read).toMatchObject({ serverId: "docs", resourceId: RESOURCE_ID });
			expect(session.readMcpResource).toHaveBeenCalledWith("docs", RESOURCE_ID);

			const promptList = successData(await controller.dispatch({ type: "mcp.list_prompts", serverId: "docs" }), "mcp.list_prompts");
			expect(promptList).toMatchObject({ truncated: false });
			expect(session.listMcpPrompts).toHaveBeenCalledWith("docs", undefined);

			const get = successData(
				await controller.dispatch({ type: "mcp.get_prompt", serverId: "docs", promptId: PROMPT_ID, args: { threadId: "t1" } }),
				"mcp.get_prompt",
			);
			expect(get).toMatchObject({ serverId: "docs", promptId: PROMPT_ID });
			expect(session.getMcpPrompt).toHaveBeenCalledWith("docs", PROMPT_ID, { threadId: "t1" });

			// None of the MCP commands touched the model loop or the run machinery.
			expect(session.prompt).not.toHaveBeenCalled();
			expect(session.steer).not.toHaveBeenCalled();
			expect(session.followUp).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("routes attach commands explicitly and returns metadata/digest receipts without remote text", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			const attachResource = successData(
				await controller.dispatch({ type: "mcp.attach_resource", serverId: "docs", resourceId: RESOURCE_ID }),
				"mcp.attach_resource",
			);
			expect(session.attachMcpResource).toHaveBeenCalledWith("docs", RESOURCE_ID);
			expect(attachResource).toMatchObject({ attachmentId: "source-resource", serverId: "docs", contentLength: 10 });
			expect(JSON.stringify(attachResource)).not.toContain("guide text");
			expect(JSON.stringify(attachResource)).not.toContain("file:///guide.md");

			const attachPrompt = successData(
				await controller.dispatch({ type: "mcp.attach_prompt", serverId: "docs", promptId: PROMPT_ID, args: { threadId: "t1" } }),
				"mcp.attach_prompt",
			);
			expect(session.attachMcpPrompt).toHaveBeenCalledWith("docs", PROMPT_ID, { threadId: "t1" });
			expect(attachPrompt).toMatchObject({ attachmentId: "source-prompt", serverId: "docs", contentLength: 15 });
			expect(JSON.stringify(attachPrompt)).not.toContain("please summarize");

			expect(session.prompt).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("gates attach commands while the Automation Host is initialized", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			const init = await controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(init).toMatchObject({ type: "response", command: "initialize", success: true });

			const attach = await controller.dispatch({ type: "mcp.attach_resource", serverId: "docs", resourceId: RESOURCE_ID });
			expect(attach).toMatchObject({ type: "response", command: "mcp.attach_resource", success: false });
			expect((attach as { error: string }).error).toContain("not available while the Automation Host is initialized");
			expect(session.attachMcpResource).not.toHaveBeenCalled();

			// Read-only MCP commands stay available while the host is initialized.
			const read = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			expect(read).toMatchObject({ success: true });
		} finally {
			await cleanup();
		}
	});

	it("maps MCP content failures to fixed structured Automation Errors", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			session.readMcpResource.mockRejectedValueOnce(new MCPError("not_selected", "docs", `MCP server "docs" is not selected for this binding`));
			const denied = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			expect(denied).toMatchObject({
				type: "response",
				command: "mcp.read_resource",
				success: false,
				error: { code: "capability_denied", retryable: false },
			});

			session.readMcpResource.mockRejectedValueOnce(new MCPError("connect_failed", "docs", `Failed to connect to MCP server "docs"`));
			const connect = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			expect(connect).toMatchObject({ success: false, error: { code: "capability_mcp_connect_failed" } });

			session.getMcpPrompt.mockRejectedValueOnce(new MCPError("unavailable", "docs", `MCP server "docs" is unavailable`));
			const unavailable = await controller.dispatch({ type: "mcp.get_prompt", serverId: "docs", promptId: PROMPT_ID });
			expect(unavailable).toMatchObject({ success: false, error: { code: "capability_mcp_unavailable" } });

			// Unknown errors degrade to the fallback code and a fixed message;
			// raw error text (and any embedded secret) never reaches the wire.
			session.readMcpResource.mockRejectedValueOnce(new Error("raw remote failure with token=super-secret"));
			const fallback = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			const fallbackError = (fallback as { error: { code: string; message: string } }).error;
			expect(fallbackError.code).toBe("capability_mcp_unavailable");
			expect(JSON.stringify(fallback)).not.toContain("super-secret");
		} finally {
			await cleanup();
		}
	});

	it("never lets crafted CapabilityError / PolicyError / MCPError messages reach the wire", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			// A CapabilityError carrying a crafted message with a token, raw URI,
			// capability id, and policy source must classify to its code and never
			// leak the crafted text: the public boundary always serializes the
			// fixed generic message.
			session.readMcpResource.mockRejectedValueOnce(
				new CapabilityError(
					"capability_denied",
					`raw capability message token=cap-secret uri=file:///leak.md capId=cap:global:leak policy=my.policy`,
				),
			);
			const denied = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			const deniedError = (denied as { error: { code: string; message: string } }).error;
			expect(deniedError.code).toBe("capability_denied");
			expect(deniedError.message).toBe("Automation request failed.");
			const deniedJson = JSON.stringify(denied);
			expect(deniedJson).not.toContain("cap-secret");
			expect(deniedJson).not.toContain("leak.md");
			expect(deniedJson).not.toContain("cap:global:leak");
			expect(deniedJson).not.toContain("my.policy");
			expect(deniedJson).not.toContain("raw capability message");

			// A PolicyError message is code-derived by construction; the wire
			// message must be the fixed public boundary text, never the caller-
			// supplied text.
			session.getMcpPrompt.mockRejectedValueOnce(
				new PolicyError("policy_denied", "crafted policy text with token=policy-secret"),
			);
			const policyDenied = await controller.dispatch({ type: "mcp.get_prompt", serverId: "docs", promptId: PROMPT_ID });
			const policyError = (policyDenied as { error: { code: string; message: string } }).error;
			expect(policyError.code).toBe("policy_denied");
			expect(policyError.message).toBe("Automation request failed.");
			expect(JSON.stringify(policyDenied)).not.toContain("policy-secret");

			// An MCPError message is fixed by construction; the wire message must
			// be the fixed public boundary text, never the error's own text.
			session.readMcpResource.mockRejectedValueOnce(
				new MCPError("unavailable", "docs", `crafted mcp text token=mcp-secret url=${AUTH_URL}`),
			);
			const mcpFailed = await controller.dispatch({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID });
			const mcpError = (mcpFailed as { error: { code: string; message: string } }).error;
			expect(mcpError.code).toBe("capability_mcp_unavailable");
			expect(mcpError.message).toBe("Automation request failed.");
			const mcpJson = JSON.stringify(mcpFailed);
			expect(mcpJson).not.toContain("mcp-secret");
			expect(mcpJson).not.toContain(AUTH_URL);

			// A sandbox PolicyError classifies to its stable code.
			session.attachMcpResource.mockRejectedValueOnce(new PolicyError("sandbox_required"));
			const sandbox = await controller.dispatch({ type: "mcp.attach_resource", serverId: "docs", resourceId: RESOURCE_ID });
			const sandboxError = (sandbox as { error: { code: string; message: string } }).error;
			expect(sandboxError.code).toBe("sandbox_required");
			expect(sandboxError.message).toBe("Automation request failed.");
			expect(JSON.stringify(sandbox)).not.toContain("sandbox provider");
		} finally {
			await cleanup();
		}
	});

	it("routes mcp.auth.start headlessly and publishes the auth URL at most once", async () => {
		const { controller, session, records, cleanup } = await createHarness();
		try {
			const start = successData(await controller.dispatch({ type: "mcp.auth.start", serverId: "docs" }), "mcp.auth.start");
			expect(session.startMcpAuth).toHaveBeenCalledWith("docs");
			// Headless start must not wait for a callback the RPC transport
			// cannot deliver.
			expect(session.waitForMcpAuth).not.toHaveBeenCalled();
			expect(session.getMcpAuthStatus).toHaveBeenCalledWith("docs");
			expect(start).toMatchObject({
				serverId: "docs",
				outcome: "interaction_required",
				status: { serverId: "docs", authSupported: true },
			});
			// The auth URL is never part of any status view.
			expect(JSON.stringify(start)).not.toContain(AUTH_URL);

			// The URL is delivered exactly once as an explicit interactive event.
			const urlEvents = records.filter((record) => record.type === "mcp.auth.url");
			expect(urlEvents).toHaveLength(1);
			expect(urlEvents[0]).toMatchObject({ type: "mcp.auth.url", serverId: "docs", url: AUTH_URL });
		} finally {
			await cleanup();
		}
	});

	it("does not publish an auth URL when the flow starts already authorized", async () => {
		const { controller, session, records, cleanup } = await createHarness();
		try {
			session.startMcpAuth.mockResolvedValueOnce({
				outcome: "authorized",
				status: { serverId: "docs", state: "authenticated" },
			});
			session.getMcpAuthStatus.mockResolvedValueOnce({
				serverId: "docs",
				authSupported: true,
				auth: { serverId: "docs", state: "authenticated" },
				credential: {
					serverId: "docs",
					hasCredential: true,
					status: "valid",
					expiresAt: 9999,
					scopes: ["read"],
					revision: 1,
				},
			});
			const start = successData(await controller.dispatch({ type: "mcp.auth.start", serverId: "docs" }), "mcp.auth.start");
			expect(start).toMatchObject({ outcome: "authorized", status: { auth: { state: "authenticated" } } });
			expect(records.filter((record) => record.type === "mcp.auth.url")).toHaveLength(0);
			expect(session.waitForMcpAuth).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("maps auth failures to fixed structured Automation Errors", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			session.startMcpAuth.mockRejectedValueOnce(new MCPAuthError("mcp_auth_required", "docs"));
			const failed = await controller.dispatch({ type: "mcp.auth.start", serverId: "docs" });
			expect(failed).toMatchObject({
				type: "response",
				command: "mcp.auth.start",
				success: false,
				error: { code: "capability_mcp_auth_required", retryable: false },
			});

			// A server that does not support OAuth degrades to capability_denied.
			session.startMcpAuth.mockRejectedValueOnce(new MCPAuthError("mcp_auth_unsupported", "docs"));
			const unsupported = await controller.dispatch({ type: "mcp.auth.start", serverId: "docs" });
			expect(unsupported).toMatchObject({ success: false, error: { code: "capability_denied" } });

			// Unknown errors degrade to a fixed fallback message.
			session.startMcpAuth.mockRejectedValueOnce(new Error("raw oauth failure with secret=super-secret"));
			const fallback = await controller.dispatch({ type: "mcp.auth.start", serverId: "docs" });
			const fallbackError = (fallback as { error: { code: string; message: string } }).error;
			expect(fallbackError.code).toBe("capability_mcp_auth_required");
			expect(JSON.stringify(fallback)).not.toContain("super-secret");
		} finally {
			await cleanup();
		}
	});

	it("routes mcp.auth.logout to the Session auth method and maps failures", async () => {
		const { controller, session, cleanup } = await createHarness();
		try {
			const logout = await controller.dispatch({ type: "mcp.auth.logout", serverId: "docs" });
			expect(logout).toMatchObject({ type: "response", command: "mcp.auth.logout", success: true });
			expect(session.logoutMcpAuth).toHaveBeenCalledWith("docs");

			session.logoutMcpAuth.mockRejectedValueOnce(new MCPAuthError("mcp_auth_required", "docs"));
			const failed = await controller.dispatch({ type: "mcp.auth.logout", serverId: "docs" });
			expect(failed).toMatchObject({ success: false, error: { code: "capability_mcp_auth_required" } });
		} finally {
			await cleanup();
		}
	});
});

describe("RpcClient MCP public surface", () => {
	type RpcClientPrivate = {
		send: (command: { type: string }, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>;
	};

	function createClient(): { client: RpcClient; privateClient: RpcClientPrivate } {
		const client = new RpcClient();
		return { client, privateClient: client as unknown as RpcClientPrivate };
	}

	const listResponse = {
		type: "response",
		command: "mcp.list_resources",
		success: true,
		data: {
			items: [
				{
					serverId: "docs",
					resourceId: RESOURCE_ID,
					name: "Guide",
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		},
	};

	it("forwards canonical MCP commands with typed results", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async (): Promise<unknown> => listResponse);
		privateClient.send = send;

		const list = await client.listMcpResources("docs", { cursor: "page-2" });
		expect(send).toHaveBeenCalledWith({ type: "mcp.list_resources", serverId: "docs", cursor: "page-2" }, undefined, undefined);
		expect(list).toMatchObject({ truncated: false });

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.read_resource",
			success: true,
			data: {
				serverId: "docs",
				resourceId: RESOURCE_ID,
				content: { blocks: [], truncated: false, unsafe: false, droppedBlocks: 0, droppedBytes: 0, byteCount: 0 },
				byteCount: 0,
				truncated: false,
				provenanceId: "mcp-content-1111111111111111",
				revision: "rev:1111111111111111",
			},
		});
		await client.readMcpResource("docs", RESOURCE_ID);
		expect(send).toHaveBeenLastCalledWith({ type: "mcp.read_resource", serverId: "docs", resourceId: RESOURCE_ID }, undefined, undefined);

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.attach_resource",
			success: true,
			data: { attachmentId: "source-resource", serverId: "docs", contentLength: 10, truncated: false },
		});
		const receipt = await client.attachMcpResource("docs", RESOURCE_ID);
		expect(receipt).toMatchObject({ attachmentId: "source-resource" });
		expect(send).toHaveBeenLastCalledWith({ type: "mcp.attach_resource", serverId: "docs", resourceId: RESOURCE_ID }, undefined, undefined);

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.list_prompts",
			success: true,
			data: {
			items: [
				{
					serverId: "docs",
					promptId: PROMPT_ID,
					name: "summarize",
					provenanceId: "mcp-content-1111111111111111",
					revision: "rev:1111111111111111",
				},
			],
			truncated: false,
		},
		});
		await client.listMcpPrompts("docs");
		expect(send).toHaveBeenLastCalledWith({ type: "mcp.list_prompts", serverId: "docs" }, undefined, undefined);

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.get_prompt",
			success: true,
			data: {
				serverId: "docs",
				promptId: PROMPT_ID,
				messages: [],
				provenanceId: "mcp-content-1111111111111111",
				revision: "rev:1111111111111111",
			},
		});
		await client.getMcpPrompt("docs", PROMPT_ID, { threadId: "t1" });
		expect(send).toHaveBeenLastCalledWith(
			{ type: "mcp.get_prompt", serverId: "docs", promptId: PROMPT_ID, args: { threadId: "t1" } },
			undefined,
			undefined,
		);

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.attach_prompt",
			success: true,
			data: { attachmentId: "source-prompt", serverId: "docs", contentLength: 15, truncated: false },
		});
		await client.attachMcpPrompt("docs", PROMPT_ID, { threadId: "t1" });
		expect(send).toHaveBeenLastCalledWith(
			{ type: "mcp.attach_prompt", serverId: "docs", promptId: PROMPT_ID, args: { threadId: "t1" } },
			undefined,
			undefined,
		);

		send.mockResolvedValueOnce({
			type: "response",
			command: "mcp.auth.logout",
			success: true,
		});
		await client.logoutMcpServer("docs");
		expect(send).toHaveBeenLastCalledWith({ type: "mcp.auth.logout", serverId: "docs" }, undefined, undefined);
	});

	it("forwards mcp.auth.start with the default auth wait and returns sanitized outcome/status", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "mcp.auth.start",
			success: true,
			data: {
				serverId: "docs",
				outcome: "interaction_required",
				status: { serverId: "docs", authSupported: true },
			},
		}));
		privateClient.send = send;

		const result = await client.startMcpAuth("docs");
		expect(send).toHaveBeenCalledWith({ type: "mcp.auth.start", serverId: "docs" }, undefined, 300_000);
		expect(result).toMatchObject({ serverId: "docs", outcome: "interaction_required" });
		expect(JSON.stringify(result)).not.toContain("authorize");
	});

	it("threads an explicit AbortSignal and timeout to startMcpAuth", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "mcp.auth.start",
			success: true,
			data: { serverId: "docs", outcome: "authorized", status: { serverId: "docs", authSupported: true } },
		}));
		privateClient.send = send;
		const controller = new AbortController();

		await client.startMcpAuth("docs", controller.signal, 42_000);
		expect(send).toHaveBeenCalledWith({ type: "mcp.auth.start", serverId: "docs" }, controller.signal, 42_000);
	});

	it("rejects immediately when the caller signal is already aborted", async () => {
		const client = new RpcClient();
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));

		// No stubbed send: the real send() must reject on the pre-flight abort
		// check before any transport/process state is touched.
		await expect(client.readMcpResource("docs", "file:///guide.md", controller.signal)).rejects.toThrow("cancelled by caller");
	});

	it("rejects with the abort reason when the signal fires while a request is pending", async () => {
		const { client } = createFakeStartedClient();
		const controller = new AbortController();

		const pending = client.readMcpResource("docs", "file:///guide.md", controller.signal);
		controller.abort(new Error("cancelled while pending"));
		await expect(pending).rejects.toThrow("cancelled while pending");
		// A late response for the aborted request must not settle the client.
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	it("rejects with the timeout error when startMcpAuth exceeds timeoutMs", async () => {
		const { client } = createFakeStartedClient();

		await expect(client.startMcpAuth("docs", undefined, 10)).rejects.toThrow(/Timeout waiting for response to mcp.auth.start/);
	});
});

/**
 * A client whose stdio transport is faked so the real send()/abort/timeout
 * logic runs without spawning a process. The fake stdin never completes a
 * write, so requests stay pending until aborted or timed out.
 */
function createFakeStartedClient(): { client: RpcClient } {
	const client = new RpcClient() as unknown as {
		process: {
			exitCode: number | null;
			stdin: {
				destroyed: boolean;
				writable: boolean;
				write: (line: string, encoding: string, cb: (error?: Error | null) => void) => void;
			};
		};
		inputStream: {
			destroyed: boolean;
			writable: boolean;
			write: (line: string, encoding: string, cb: (error?: Error | null) => void) => void;
		};
		stderr: string;
		pendingRequests: Map<string, unknown>;
	};
	const fakeStdin = {
		destroyed: false,
		writable: true,
		// Keep the write pending forever: only abort/timeout settle the request.
		write: () => {},
	};
	client.process = { exitCode: null, stdin: fakeStdin };
	client.inputStream = fakeStdin;
	client.stderr = "";
	client.pendingRequests = new Map();
	return { client: client as unknown as RpcClient };
}
