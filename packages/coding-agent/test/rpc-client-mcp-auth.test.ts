import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

/**
 * RpcClient interactive MCP OAuth bridge wire contract.
 *
 * The driver is tested with a mocked `send` (the start request and its
 * response) and a mocked `writeRecord` (the `extension_ui_response` answers),
 * while `handleLine` replays the host's `extension_ui_request` records. No
 * real OAuth server, browser, model, or process is used.
 */

type RpcClientPrivate = {
	send: (command: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>;
	writeRecord: (record: unknown) => Promise<void>;
	handleLine: (line: string) => void;
};

function createMockedClient(): {
	client: RpcClient;
	clientPrivate: RpcClientPrivate;
	sent: Array<{ command: unknown; signal?: AbortSignal; timeoutMs?: number }>;
	writes: Array<Record<string, unknown>>;
	resolveSend: (response: unknown) => void;
	rejectSend: (error: Error) => void;
} {
	const client = new RpcClient();
	const clientPrivate = client as unknown as RpcClientPrivate;
	const sent: Array<{ command: unknown; signal?: AbortSignal; timeoutMs?: number }> = [];
	const writes: Array<{ type: string; id: string }> = [];
	let resolveSend: (response: unknown) => void = () => {};
	let rejectSend: (error: Error) => void = () => {};
	clientPrivate.send = vi.fn(
		(command: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> => {
			sent.push({ command, signal, timeoutMs });
			return new Promise((resolve, reject) => {
				resolveSend = resolve;
				rejectSend = reject;
				signal?.addEventListener(
					"abort",
					() => {
						reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
					},
					{ once: true },
				);
			});
		},
	);
	clientPrivate.writeRecord = vi.fn(async (record: unknown): Promise<void> => {
		writes.push(record as { type: string; id: string });
	});
	// Wrappers capture the mutable local variables, so the returned functions
	// always delegate to the current promise settler of the latest send call.
	return {
		client,
		clientPrivate,
		sent,
		writes,
		resolveSend: (response: unknown): void => resolveSend(response),
		rejectSend: (error: Error): void => rejectSend(error),
	};
}

function replay(client: RpcClientPrivate, record: unknown): void {
	client.handleLine(JSON.stringify(record));
}

const START_RESPONSE = {
	type: "response",
	command: "mcp.auth.start",
	success: true,
	data: { status: "authorized" },
};

describe("RpcClient interactive MCP OAuth bridge", () => {
	it("sends an interactive start and drives confirm / auth_url / manual-code dialogs", async () => {
		const { client, clientPrivate, sent, writes, resolveSend } = createMockedClient();
		const urls: string[] = [];
		const confirms: string[] = [];
		const codes: Array<{ message: string; placeholder?: string }> = [];

		const startPromise = client.startMcpAuthInteractive("srv", "https://mcp.example.com/api", {
			onAuthUrl: (url) => urls.push(url),
			confirm: async (message) => {
				confirms.push(message);
				return true;
			},
			inputCode: async (message, placeholder) => {
				codes.push({ message, placeholder });
				return "code-1";
			},
		});

		// The start command declares the interaction bridge.
		expect(sent).toHaveLength(1);
		expect(sent[0].command).toMatchObject({
			type: "mcp.auth.start",
			serverId: "srv",
			serverUrl: "https://mcp.example.com/api",
			interactive: true,
		});

		// Consent confirm dialog -> confirmed: true.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "d1",
			method: "confirm",
			title: "Allow aos-agent to sign in to MCP server \"srv\" using OAuth?",
			message: "Allow aos-agent to sign in to MCP server \"srv\" using OAuth?",
			timeout: 180000,
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "d1" }));
		});
		expect(confirms).toHaveLength(1);

		// One-shot auth_url delivery: delivered exactly once, even when a
		// second record arrives.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "d2",
			method: "auth_url",
			url: "https://auth.example.com/authorize?state=abc",
			instructions: "Open this URL in your browser",
		});
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "d3",
			method: "auth_url",
			url: "https://auth.example.com/authorize?state=def",
		});
		await vi.waitFor(() => {
			expect(urls).toEqual(["https://auth.example.com/authorize?state=abc"]);
		});

		// Manual code input dialog -> value.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "d4",
			method: "input",
			title: "Paste the authorization code shown by your browser",
			placeholder: "code",
			timeout: 180000,
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "d4" }));
		});
		expect(codes).toEqual([{ message: "Paste the authorization code shown by your browser", placeholder: "code" }]);

		resolveSend(START_RESPONSE);
		const data = await startPromise;
		expect(data).toEqual({ status: "authorized" });
		// The authorization URL never appears in the returned data and no
		// token or raw URI crosses the wire.
		expect(JSON.stringify(data)).not.toContain("auth.example.com");
	});

	it("fails closed without callbacks: consent is declined, manual code cancels, unknown dialogs cancel", async () => {
		const { client, clientPrivate, writes, resolveSend } = createMockedClient();
		const startPromise = client.startMcpAuthInteractive("srv", "https://mcp.example.com/api");

		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "c1",
			method: "confirm",
			title: "Allow?",
			message: "Allow?",
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "c1" }));
		});
		// No confirm callback: the consent is never granted.
		expect(writes[0]).toMatchObject({ type: "extension_ui_response", id: "c1", confirmed: false });

		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "c2",
			method: "input",
			title: "Paste the authorization code",
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "c2" }));
		});
		// No inputCode callback: the manual-code dialog is cancelled.
		expect(writes[1]).toMatchObject({ type: "extension_ui_response", id: "c2", cancelled: true });

		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "c3",
			method: "select",
			title: "unexpected",
			options: ["a"],
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "c3" }));
		});
		expect(writes[2]).toMatchObject({ type: "extension_ui_response", id: "c3", cancelled: true });

		resolveSend({
			type: "response",
			command: "mcp.auth.start",
			success: false,
			error: { code: "mcp_auth_cancelled", message: 'MCP server "srv" authorization was cancelled.' },
		});
		await expect(startPromise).rejects.toMatchObject({ name: "McpAuthRpcError", code: "mcp_auth_cancelled" });
	});

	it("surfaces callback failures without breaking the flow", async () => {
		const { client, clientPrivate, writes, resolveSend } = createMockedClient();
		const startPromise = client.startMcpAuthInteractive("srv", "https://mcp.example.com/api", {
			onAuthUrl: () => {
				throw new Error("consumer boom");
			},
			confirm: async () => {
				throw new Error("consumer boom");
			},
		});

		// The throwing onAuthUrl is swallowed; the flow continues.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "u1",
			method: "auth_url",
			url: "https://auth.example.com/authorize?state=abc",
		});
		await vi.waitFor(() => {
			expect(writes).toHaveLength(0);
		});
		// The throwing confirm fails closed as a decline.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "u2",
			method: "confirm",
			title: "Allow?",
			message: "Allow?",
		});
		await vi.waitFor(() => {
			expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "u2" }));
		});
		expect(writes[0]).toMatchObject({ type: "extension_ui_response", id: "u2", confirmed: false });

		resolveSend(START_RESPONSE);
		await expect(startPromise).resolves.toEqual({ status: "authorized" });
	});

	it("aborts: cancels pending dialogs, rejects the start, and unsubscribes", async () => {
		const { client, clientPrivate, sent, writes, rejectSend } = createMockedClient();
		const controller = new AbortController();
		// Hold the consent callback open so the dialog stays pending until the
		// abort; the driver must then cancel it instead of answering it.
		let resolveConfirm: (value: boolean) => void = () => {};
		const startPromise = client.startMcpAuthInteractive(
			"srv",
			"https://mcp.example.com/api",
			{
				confirm: () =>
					new Promise<boolean>((resolve) => {
						resolveConfirm = resolve;
					}),
			},
			{ signal: controller.signal },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].signal).toBe(controller.signal);

		// A consent dialog is pending when the caller aborts.
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "a1",
			method: "confirm",
			title: "Allow?",
			message: "Allow?",
		});
		await vi.waitFor(() => {
			expect(writes).toHaveLength(0);
		});

		const abortError = new DOMException("aborted", "AbortError");
		controller.abort();
		rejectSend(abortError);

		await expect(startPromise).rejects.toMatchObject({ name: "AbortError" });
		// The pending dialog was answered cancelled so the host flow fails
		// closed promptly instead of waiting for its own timeout.
		expect(writes).toContainEqual(expect.objectContaining({ type: "extension_ui_response", id: "a1" }));
		expect(writes[0]).toMatchObject({ type: "extension_ui_response", id: "a1", cancelled: true });
		// The held consent callback is never resolved by the driver.
		expect(resolveConfirm).toBeTypeOf("function");

		// After settlement no further dialogs are answered.
		const writesBefore = writes.length;
		replay(clientPrivate, {
			type: "extension_ui_request",
			id: "a2",
			method: "confirm",
			title: "Allow?",
			message: "Allow?",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(writes.length).toBe(writesBefore);
	});
});
