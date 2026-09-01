import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import { AutomationRpcError, RpcClient } from "../src/modes/rpc/rpc-client.ts";

const LOOPBACK_HOST = "127.0.0.1";
const TRANSIENT_WINDOWS_CONNECT_CODES = new Set(["EADDRNOTAVAIL", "ECONNREFUSED", "ECONNRESET", "ENOBUFS", "ETIMEDOUT"]);
const TCP_CONNECT_ATTEMPTS = 3;
const clients: RpcClient[] = [];
const servers: Server[] = [];

type RpcRecord = Record<string, unknown>;
type RpcRequestHandler = (socket: Socket, request: RpcRecord) => void;

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.close();
	}
	for (const server of servers.splice(0)) {
		await closeServer(server);
	}
});

describe("RpcClient TCP transport", () => {
	it("exposes session list, archive, and unarchive commands", async () => {
		const received: RpcRecord[] = [];
		const { server, port } = await listen((socket, request) => {
			received.push(request);
			const command = request.type;
			const data =
				command === "list_sessions"
					? {
							sessions: [
								{
									path: "/sessions/one.jsonl",
									id: "one",
									cwd: "/workspace",
									archived: true,
									archivedAt: "2026-09-01T12:00:00.000Z",
									created: "2026-09-01T10:00:00.000Z",
									modified: "2026-09-01T11:00:00.000Z",
									messageCount: 1,
									firstMessage: "first",
									allMessagesText: "first",
								},
							],
						}
					: command === "archive_session"
						? { archived: true, archivedAt: "2026-09-01T12:00:00.000Z" }
						: { archived: false };
			socket.write(
				serializeJsonLine({ type: "response", id: request.id, command, success: true, data }),
			);
		});
		servers.push(server);
		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		await startTcpClient(client);

		await expect(client.listSessions({ all: true, includeArchived: true })).resolves.toMatchObject([
			{ id: "one", archived: true },
		]);
		await expect(client.archiveSession("/sessions/one.jsonl")).resolves.toMatchObject({ archived: true });
		await expect(client.unarchiveSession("/sessions/one.jsonl")).resolves.toEqual({ archived: false });
		expect(received.map(({ id: _id, ...request }) => request)).toEqual([
			{ type: "list_sessions", all: true, includeArchived: true },
			{ type: "archive_session", sessionPath: "/sessions/one.jsonl" },
			{ type: "unarchive_session", sessionPath: "/sessions/one.jsonl" },
		]);
	});

	it("connects without spawning the configured CLI and routes shared JSONL responses and events", async () => {
		const receivedCommands: string[] = [];
		const { server, port } = await listen((socket, request) => {
			const command = typeof request.type === "string" ? request.type : "unknown";
			receivedCommands.push(command);
			const response = {
				type: "response",
				id: request.id,
				command,
				success: true,
				data:
					command === "initialize"
						? {
								host: "automation-host",
								protocolVersion: 1,
								sessionId: "session-1",
								runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
							}
						: command === "audit.query"
							? { schemaVersion: 1, scope: "current-session", events: [], warnings: [] }
							: command === "audit.replay"
								? {
										schemaVersion: 1,
										run: {
											status: "completed",
											attempt: 1,
											model: { provider: "p", id: "m", thinkingLevel: "low" },
										},
										events: [],
										status: "complete",
										warnings: [],
									}
								: undefined,
			};
			const eventRecords =
				command === "initialize"
					? [
							{ type: "run.started", runId: "run-1", sessionId: "session-1", sequence: 1, timestamp: "t1" },
							{ type: "agent_settled" },
						]
					: [];
			const payload = [response, ...eventRecords].map((record) => serializeJsonLine(record)).join("");
			// Split the write to exercise the same stream framing used by stdio.
			socket.write(payload.slice(0, Math.max(1, Math.floor(payload.length / 2))));
			socket.write(payload.slice(Math.max(1, Math.floor(payload.length / 2))));
		});
		servers.push(server);

		const client = new RpcClient({
			cliPath: "missing-cli-entry-point.js",
			transport: { type: "tcp", port },
		});
		clients.push(client);
		const runEvents: string[] = [];
		const sessionEvents: string[] = [];
		client.onRunEvent((event) => runEvents.push(event.type));
		client.onEvent((event) => sessionEvents.push(event.type));

		await startTcpClient(client);
		await expect(client.initializeAutomationHost()).resolves.toMatchObject({ sessionId: "session-1" });
		await expect(client.auditQuery({ scope: "current-session" })).resolves.toMatchObject({ schemaVersion: 1 });
		await expect(client.auditReplay("run-1")).resolves.toMatchObject({ status: "complete" });

		expect(receivedCommands).toEqual(["initialize", "audit.query", "audit.replay"]);
		expect(runEvents).toEqual(["run.started"]);
		expect(sessionEvents).toEqual(["agent_settled"]);
	});

	it("rejects non-loopback TCP options before attempting a connection", async () => {
		const client = new RpcClient({
			cliPath: "missing-cli-entry-point.js",
			transport: { type: "tcp", host: "localhost", port: 1, connectTimeoutMs: 20 },
		});
		clients.push(client);

		await expect(client.start()).rejects.toMatchObject({ code: "rpc_transport_not_loopback" });
	});

	it.each([0, 65_536])("rejects TCP port %s before attempting a connection", async (port) => {
		const client = new RpcClient({
			cliPath: "missing-cli-entry-point.js",
			transport: { type: "tcp", port },
		});
		clients.push(client);

		await expect(client.start()).rejects.toMatchObject({ code: "rpc_transport_address_invalid" });
	});

	it("honors explicit stdio transport over the TCP convenience option", async () => {
		const client = new RpcClient({
			cliPath: "missing-cli-entry-point.js",
			transport: "stdio",
			tcp: { port: 0 },
		});
		expect((client as unknown as { resolveTcpOptions: () => unknown }).resolveTcpOptions()).toBeNull();
	});

	it("rejects all pending requests and closes the socket", async () => {
		let acceptedSocket: Socket | undefined;
		let commandReceived!: () => void;
		const commandReady = new Promise<void>((resolve) => {
			commandReceived = resolve;
		});
		const { server, port } = await listen((socket, request) => {
			acceptedSocket = socket;
			if (request.type === "get_commands") commandReceived();
		});
		servers.push(server);

		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		await startTcpClient(client);
		const pending = client.getCommands();
		await commandReady;
		const socketClosed = waitForClose(acceptedSocket!);
		const pendingExpectation = expect(pending).rejects.toThrow();

		await client.stop();

		await pendingExpectation;
		await socketClosed;
		await expect(client.getCommands()).rejects.toThrow();
	});

	it("clears every pending request after a remote close without replaying commands", async () => {
		let requestCount = 0;
		let acceptedSocket: Socket | undefined;
		const { server, port } = await listen((socket) => {
			acceptedSocket = socket;
			requestCount += 1;
			if (requestCount === 2) socket.destroy();
		});
		servers.push(server);

		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		await startTcpClient(client);
		const first = client.getCommands();
		const second = client.getCommands();
		const firstRejected = expect(first).rejects.toMatchObject({ code: "rpc_transport_closed" });
		const secondRejected = expect(second).rejects.toMatchObject({ code: "rpc_transport_closed" });
		await vi.waitFor(() => expect(requestCount).toBe(2));

		await firstRejected;
		await secondRejected;
		await expect(client.getCommands()).rejects.toMatchObject({ code: "rpc_transport_closed" });
		expect(requestCount).toBe(2);
		expect(acceptedSocket?.destroyed).toBe(true);
	});

	it("preserves structured AutomationRpcError responses over TCP", async () => {
		const { server, port } = await listen((socket, request) => {
			if (request.type !== "run.start") return;
			socket.write(
				serializeJsonLine({
					type: "response",
					id: request.id,
					command: "run.start",
					success: false,
					error: { code: "session_busy", message: "A run is already active", retryable: true },
				}),
			);
		});
		servers.push(server);

		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		await startTcpClient(client);

		await expect(
			client.startRun(
				"do not duplicate",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"retry-1",
			),
		).rejects.toMatchObject({
			name: "AutomationRpcError",
			code: "session_busy",
			message: "A run is already active",
			retryable: true,
		});
		await expect(client.startRun("do not duplicate")).rejects.toBeInstanceOf(AutomationRpcError);
	});

	it("rejects pending requests for TCP transport errors without routing them as events", async () => {
		const { server, port } = await listen((socket, request) => {
			if (request.type !== "initialize") return;
			socket.write(
				serializeJsonLine({
					type: "error",
					error: { code: "rpc_transport_connection_busy", message: "Another control connection is active" },
				}),
			);
		});
		servers.push(server);

		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		const runEvents: string[] = [];
		const sessionEvents: string[] = [];
		client.onRunEvent((event) => runEvents.push(event.type));
		client.onEvent((event) => sessionEvents.push(event.type));

		await startTcpClient(client);
		await expect(client.initializeAutomationHost()).rejects.toMatchObject({
			name: "RpcTransportError",
			code: "rpc_transport_connection_busy",
			message: "Another control connection is active",
		});
		expect(runEvents).toEqual([]);
		expect(sessionEvents).toEqual([]);
	});

	it("does not auto-replay side effects and preserves clientRequestId for an explicit retry", async () => {
		let attempt = 0;
		const { server, port } = await listen((socket, request) => {
			if (request.type !== "run.start") return;
			attempt += 1;
			if (attempt === 1) {
				socket.destroy();
				return;
			}
			socket.write(
				serializeJsonLine({
					type: "response",
					id: request.id,
					command: "run.start",
					success: true,
					data: {
						runId: "run-1",
						sessionId: "session-1",
						attempt: 1,
						status: "accepted",
						clientRequestId: request.clientRequestId,
						idempotent: true,
					},
				}),
			);
		});
		servers.push(server);

		const client = new RpcClient({ transport: { type: "tcp", port } });
		clients.push(client);
		await startTcpClient(client);
		await expect(
			client.startRun("side effect", undefined, undefined, undefined, undefined, undefined, "request-1"),
		).rejects.toMatchObject({ code: "rpc_transport_closed" });
		await client.close();
		expect(attempt).toBe(1);

		await startTcpClient(client);
		const retry = await client.startRun(
			"side effect",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"request-1",
		);
		expect(attempt).toBe(2);
		expect(retry).toMatchObject({ runId: "run-1", clientRequestId: "request-1", idempotent: true });
	});
});

async function listen(handler: RpcRequestHandler): Promise<{ server: Server; port: number }> {
	const server = createServer((socket) => {
		attachJsonlLineReader(socket, (line) => {
			const parsed: unknown = JSON.parse(line);
			if (isRpcRecord(parsed)) handler(socket, parsed);
		});
	});
	await new Promise<void>((resolve, reject) => {
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
		server.listen(0, LOOPBACK_HOST);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	return { server, port: address.port };
}

async function startTcpClient(client: RpcClient): Promise<void> {
	for (let attempt = 1; attempt <= TCP_CONNECT_ATTEMPTS; attempt += 1) {
		try {
			await client.start();
			return;
		} catch (error: unknown) {
			if (process.platform !== "win32" || attempt === TCP_CONNECT_ATTEMPTS || !isTransientConnectError(error)) {
				throw error;
			}
			// Full-suite Windows runs can transiently exhaust loopback socket buffers or ephemeral ports.
			await new Promise((resolve) => setTimeout(resolve, attempt * 50));
		}
	}
}

function isTransientConnectError(error: unknown): boolean {
	let current = error;
	while (current instanceof Error) {
		if ("code" in current && typeof current.code === "string" && TRANSIENT_WINDOWS_CONNECT_CODES.has(current.code)) {
			return true;
		}
		current = current.cause;
	}
	return false;
}

function isRpcRecord(value: unknown): value is RpcRecord {
	return typeof value === "object" && value !== null;
}

function waitForClose(socket: Socket): Promise<void> {
	if (socket.destroyed) return Promise.resolve();
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
