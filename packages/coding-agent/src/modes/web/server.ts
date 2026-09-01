import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WEB_ASSETS } from "./assets.ts";
import {
	invokeWebReadOnlyRpc,
	type WebReadOnlyRpcClient,
	WebRpcRequestError,
} from "./read-only-rpc.ts";
import { loadTaskGraphBoard } from "./task-graph-board.ts";

export const WEB_SURFACE_HOST = "127.0.0.1" as const;
const MAX_REQUEST_BYTES = 64 * 1024;
const SECURITY_HEADERS = Object.freeze({
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"cross-origin-opener-policy": "same-origin",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
});

export interface WebSurfaceServer {
	readonly host: typeof WEB_SURFACE_HOST;
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

export interface StartWebSurfaceServerOptions {
	readonly port?: number;
}

export async function startWebSurfaceServer(
	client: WebReadOnlyRpcClient,
	options: StartWebSurfaceServerOptions = {},
): Promise<WebSurfaceServer> {
	const port = options.port ?? 0;
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("Web surface port is invalid");
	const server = createServer((request, response) => {
		void handleRequest(client, request, response);
	});
	await listen(server, port);
	const address = server.address();
	if (typeof address === "string" || address === null || address.address !== WEB_SURFACE_HOST) {
		await closeServer(server);
		throw new Error("Web surface did not bind to the required IPv4 loopback address");
	}
	return {
		host: WEB_SURFACE_HOST,
		port: address.port,
		url: `http://${WEB_SURFACE_HOST}:${address.port}/`,
		close: () => closeServer(server),
	};
}

async function handleRequest(
	client: WebReadOnlyRpcClient,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const url = new URL(request.url ?? "/", `http://${WEB_SURFACE_HOST}`);
		if (url.pathname === "/api/task-graph-board") {
			if (request.method !== "GET") {
				writeJson(response, 405, { error: { code: "method_not_allowed", message: "Use GET for board data." } });
				return;
			}
			writeJson(response, 200, { data: await loadTaskGraphBoard(client) });
			return;
		}
		if (url.pathname === "/api/rpc") {
			if (request.method !== "POST") {
				writeJson(response, 405, { error: { code: "method_not_allowed", message: "Use POST for RPC requests." } });
				return;
			}
			const body = await readJsonBody(request);
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				throw new WebRpcRequestError(400, "invalid_request", "Request body must be a JSON object.");
			}
			const record = body as { method?: unknown; params?: unknown };
			if (typeof record.method !== "string") {
				throw new WebRpcRequestError(400, "invalid_request", "method must be a string.");
			}
			const data = await invokeWebReadOnlyRpc(client, record.method, record.params);
			writeJson(response, 200, { data });
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			writeJson(response, 405, { error: { code: "method_not_allowed", message: "Method is not allowed." } });
			return;
		}
		const asset = WEB_ASSETS[url.pathname];
		if (!asset) {
			writeJson(response, 404, { error: { code: "not_found", message: "Resource was not found." } });
			return;
		}
		response.writeHead(200, { ...SECURITY_HEADERS, "content-type": asset.contentType });
		response.end(request.method === "HEAD" ? undefined : asset.body);
	} catch (error: unknown) {
		if (error instanceof WebRpcRequestError) {
			writeJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
			return;
		}
		writeJson(response, 502, { error: { code: "rpc_failed", message: "Read-only RPC request failed." } });
	}
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new WebRpcRequestError(400, "invalid_request", "Content-Type must be application/json.");
	}
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) {
			throw new WebRpcRequestError(400, "invalid_request", "Request body is too large.");
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new WebRpcRequestError(400, "invalid_request", "Request body is not valid JSON.");
	}
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
	if (response.headersSent) return;
	response.writeHead(statusCode, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
	response.end(`${JSON.stringify(value)}\n`);
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: WEB_SURFACE_HOST, port });
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
