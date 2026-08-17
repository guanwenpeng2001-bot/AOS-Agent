import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";

vi.mock("node:http", () => ({ createServer: vi.fn() }));

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

class FakeResponse {
	statusCode = 0;
	body = "";

	writeHead(statusCode: number): void {
		this.statusCode = statusCode;
	}

	end(body?: string): void {
		this.body = body ?? "";
	}
}

class FakeServer extends EventEmitter {
	listening = false;
	closeCalls = 0;
	listenCalls: Array<{ port: number; host: string }> = [];
	private readonly handler: RequestHandler;
	private readonly listenError: Error | undefined;

	constructor(handler: RequestHandler, listenError?: Error) {
		super();
		this.handler = handler;
		this.listenError = listenError;
	}

	listen(port: number, host: string, callback: () => void): this {
		this.listenCalls.push({ port, host });
		if (this.listenError) {
			queueMicrotask(() => this.emit("error", this.listenError));
			return this;
		}
		this.listening = true;
		callback();
		return this;
	}

	close(callback?: (error?: Error) => void): this {
		this.closeCalls += 1;
		this.listening = false;
		callback?.();
		return this;
	}

	request(url: string): FakeResponse {
		const response = new FakeResponse();
		this.handler({ url } as IncomingMessage, response as unknown as ServerResponse);
		return response;
	}
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

const neverAbortedSignal = new AbortController().signal;
const createServerMock = vi.mocked(createServer);

describe.sequential("Anthropic OAuth callback listener", () => {
	beforeEach(() => {
		createServerMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("closes the listener after a browser callback succeeds", async () => {
		let server: FakeServer | undefined;
		createServerMock.mockImplementation((handler) => {
			server = new FakeServer(handler as RequestHandler);
			return server as unknown as ReturnType<typeof createServer>;
		});
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })));

		let callbackResponse: FakeResponse | undefined;
		let authUrl = "";
		let manualSignal: AbortSignal | undefined;
		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type !== "auth_url") return;
				authUrl = event.url;
				const authorizeUrl = new URL(authUrl);
				const state = authorizeUrl.searchParams.get("state");
				if (!state || !server) throw new Error("Missing callback state or server");
				callbackResponse = server.request(`/callback?code=callback-code&state=${state}`);
			},
			prompt: (prompt) => {
				manualSignal = prompt.signal;
				return new Promise<string>(() => {});
			},
		});

		expect(credential.access).toBe("access");
		expect(authUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback");
		expect(callbackResponse?.statusCode).toBe(200);
		expect(server?.listenCalls).toEqual([{ port: 53692, host: "127.0.0.1" }]);
		expect(server?.closeCalls).toBe(1);
		expect(server?.listening).toBe(false);
		expect(manualSignal?.aborted).toBe(true);
	});

	it("closes the listener when login is aborted", async () => {
		let server: FakeServer | undefined;
		createServerMock.mockImplementation((handler) => {
			server = new FakeServer(handler as RequestHandler);
			return server as unknown as ReturnType<typeof createServer>;
		});
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => jsonResponse({ access_token: "unexpected", refresh_token: "unexpected", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			anthropicOAuth.login({
				signal: controller.signal,
				notify: (event) => {
					if (event.type === "auth_url") controller.abort();
				},
				prompt: (prompt) => {
					if (prompt.signal?.aborted) return Promise.reject(new Error("Login cancelled"));
					return new Promise<string>((_, reject) => {
						prompt.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
					});
				},
			}),
		).rejects.toThrow("Login cancelled");

		expect(server?.closeCalls).toBe(1);
		expect(server?.listening).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("closes a failed listener before trying localhost", async () => {
		const failedServer = new FakeServer(
			() => {},
			Object.assign(new Error("permission denied"), { code: "EACCES" }),
		);
		let fallbackServer: FakeServer | undefined;
		let serverIndex = 0;
		createServerMock.mockImplementation((handler) => {
			serverIndex += 1;
			if (serverIndex === 1) return failedServer as unknown as ReturnType<typeof createServer>;
			fallbackServer = new FakeServer(handler as RequestHandler);
			return fallbackServer as unknown as ReturnType<typeof createServer>;
		});
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })));

		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: () => {},
			prompt: async () => "manual-code",
		});

		expect(credential.access).toBe("access");
		expect(failedServer.closeCalls).toBe(1);
		expect(failedServer.listening).toBe(false);
		expect(fallbackServer?.listenCalls).toEqual([{ port: 53692, host: "localhost" }]);
		expect(fallbackServer?.closeCalls).toBe(1);
	});
});
