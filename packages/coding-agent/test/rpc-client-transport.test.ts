import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import { AutomationRpcError, RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createRpcTransport, type RpcTransport } from "../src/modes/rpc/rpc-transport.ts";
import type { TcpRpcAddress, WebsocketRpcAddress } from "../src/modes/rpc/rpc-transport-address.ts";

const LOOPBACK_HOST = "127.0.0.1";
const TRANSIENT_WINDOWS_CONNECT_CODES = new Set(["EADDRNOTAVAIL", "ECONNREFUSED", "ECONNRESET", "ENOBUFS", "ETIMEDOUT"]);
const TCP_CONNECT_ATTEMPTS = 3;
const TLS_FIXTURE_CERT = join(import.meta.dirname, "../../../node_modules/ssh2/test/fixtures/https_cert.pem");
const TLS_FIXTURE_KEY = join(import.meta.dirname, "../../../node_modules/ssh2/test/fixtures/https_key.pem");
const clients: RpcClient[] = [];
const servers: Server[] = [];
const rpcTransports: Array<
	| RpcTransport<RpcRecord, RpcRecord, TcpRpcAddress>
	| RpcTransport<RpcRecord, RpcRecord, WebsocketRpcAddress>
> = [];

type RpcRecord = Record<string, unknown>;
type RpcRequestHandler = (socket: Socket, request: RpcRecord) => void;

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.close();
	}
	for (const server of servers.splice(0)) {
		await closeServer(server);
	}
	for (const transport of rpcTransports.splice(0)) {
		await transport.close();
	}
});

describe("RpcClient TCP transport", () => {
	it("exposes session list, search, archive, and unarchive commands", async () => {
		const received: RpcRecord[] = [];
		const { server, port } = await listen((socket, request) => {
			received.push(request);
			const command = request.type;
			const data =
				command === "list_sessions" || command === "search_sessions"
					? {
							sessions: [
								{
									path: "/sessions/one.jsonl",
									id: "one",
									cwd: "/workspace",
									ephemeral: false,
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
			{ id: "one", ephemeral: false, archived: true },
		]);
		await expect(client.searchSessions("first", { sort: "recent", nameFilter: "named", limit: 5 })).resolves.toMatchObject([
			{ id: "one", ephemeral: false, archived: true },
		]);
		await expect(client.archiveSession("/sessions/one.jsonl")).resolves.toMatchObject({ archived: true });
		await expect(client.unarchiveSession("/sessions/one.jsonl")).resolves.toEqual({ archived: false });
		expect(received.map(({ id: _id, ...request }) => request)).toEqual([
			{ type: "list_sessions", all: true, includeArchived: true },
			{ type: "search_sessions", query: "first", sort: "recent", nameFilter: "named", limit: 5 },
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

	it("normalizes remote TCP credentials for a secured connection", () => {
		const client = new RpcClient({
			transport: {
				type: "tcp",
				host: "remote.example",
				port: 4123,
				bearerToken: "token",
				tls: { caPath: "ca.pem", certPath: "client.pem", keyPath: "client.key" },
			},
		});
		expect((client as unknown as { resolveTcpOptions: () => unknown }).resolveTcpOptions()).toEqual({
			host: "remote.example",
			port: 4123,
			connectTimeoutMs: 10_000,
			bearerToken: "token",
			tls: { caPath: "ca.pem", certPath: "client.pem", keyPath: "client.key" },
		});
	});

	it("connects to an mTLS TCP listener with client certificate paths", async () => {
		const port = await getAvailablePort();
		const transport = createRpcTransport<RpcRecord, RpcRecord>({
			address: {
				transport: "tcp",
				host: "localhost",
				port,
				auth: { scheme: "mtls" },
				tls: {
					enabled: true,
					minVersion: "1.2",
					certRef: TLS_FIXTURE_CERT,
					keyRef: TLS_FIXTURE_KEY,
					clientCaRef: TLS_FIXTURE_CERT,
				},
			},
			dispatch: (request, sink) =>
				sink.send({
					type: "response",
					id: request.id,
					command: request.type,
					success: true,
					data: { commands: [] },
				}),
		});
		rpcTransports.push(transport);
		await transport.start();
		const client = new RpcClient({
			transport: {
				type: "tcp",
				host: "localhost",
				port,
				tls: { caPath: TLS_FIXTURE_CERT, certPath: TLS_FIXTURE_CERT, keyPath: TLS_FIXTURE_KEY },
			},
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
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

describe("RpcClient WebSocket transport", () => {
	it("sends bearer credentials in the WebSocket upgrade", async () => {
		const port = await getAvailablePort();
		const transport = createRpcTransport<RpcRecord, RpcRecord>({
			address: {
				transport: "websocket",
				host: LOOPBACK_HOST,
				port,
				path: "/rpc",
				auth: { scheme: "bearer", bearerToken: "expected-token" },
			},
			dispatch: (request, sink) =>
				sink.send({
					type: "response",
					id: request.id,
					command: request.type,
					success: true,
					data: { commands: [] },
				}),
		});
		rpcTransports.push(transport);
		await transport.start();
		const client = new RpcClient({
			transport: { type: "websocket", port, bearerToken: "expected-token" },
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("connects to a WSS listener with mTLS client certificate paths", async () => {
		const port = await getAvailablePort();
		const transport = createRpcTransport<RpcRecord, RpcRecord>({
			address: {
				transport: "websocket",
				host: "localhost",
				port,
				path: "/rpc",
				auth: { scheme: "mtls" },
				tls: {
					enabled: true,
					minVersion: "1.2",
					certRef: TLS_FIXTURE_CERT,
					keyRef: TLS_FIXTURE_KEY,
					clientCaRef: TLS_FIXTURE_CERT,
				},
			},
			dispatch: (request, sink) =>
				sink.send({
					type: "response",
					id: request.id,
					command: request.type,
					success: true,
					data: { commands: [] },
				}),
		});
		rpcTransports.push(transport);
		await transport.start();
		const client = new RpcClient({
			transport: {
				type: "websocket",
				host: "localhost",
				port,
				tls: { caPath: TLS_FIXTURE_CERT, certPath: TLS_FIXTURE_CERT, keyPath: TLS_FIXTURE_KEY },
			},
		});
		clients.push(client);
		await client.start();
		await expect(client.getCommands()).resolves.toEqual([]);
	});

	it("runs initialize, start, get, cancel, and resume over one framed connection", async () => {
		const port = await getAvailablePort();
		const commands: string[] = [];
		const transport = createRpcTransport<RpcRecord, RpcRecord>({
			address: { transport: "websocket", host: LOOPBACK_HOST, port, path: "/rpc" },
			parseCommand: (value) => value as RpcRecord,
			dispatch: async (request, sink) => {
				const command = String(request.type);
				commands.push(command);
				const runId = command === "run.resume" ? "run-2" : "run-1";
				const data =
					command === "initialize"
						? {
								host: "automation-host",
								protocolVersion: 1,
								sessionId: "session-1",
								runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
								protocol: {
									server: {
										versions: { min: 1, max: 1 },
										features: ["transport.websocket"],
									},
									negotiated: {
										version: 1,
										features: ["transport.websocket"],
										compatible: { min: 1, max: 1 },
									},
									endpoint: {
										kind: "websocket",
										loopback: true,
										authScheme: "none",
										tlsEnabled: false,
										allowRemote: false,
									},
								},
							}
						: command === "run.get"
							? {
									run: {
										id: "run-1",
										sessionId: "session-1",
										attempt: 1,
										status: "running",
										model: { provider: "p", id: "m", thinkingLevel: "low" },
										createdAt: "2026-09-01T00:00:00.000Z",
									},
								}
							: command === "run.cancel"
								? { runId: "run-1", status: "running" }
								: {
										runId,
										sessionId: "session-1",
										attempt: command === "run.resume" ? 2 : 1,
										status: "accepted",
									};
				await sink.send({
					type: "response",
					id: request.id,
					command,
					success: true,
					data,
				});
			},
		});
		rpcTransports.push(transport);
		await transport.start();
		const client = new RpcClient({ transport: { type: "websocket", port } });
		clients.push(client);
		await client.start();

		const initialized = await client.initializeAutomationHost();
		expect(initialized.protocol).toMatchObject({
			negotiated: { features: ["transport.websocket"] },
			endpoint: { kind: "websocket", authScheme: "none", tlsEnabled: false },
		});
		const started = await client.startRun("start");
		await expect(client.getRun(started.runId)).resolves.toMatchObject({ run: { status: "running" } });
		await expect(client.cancelRun(started.runId)).resolves.toEqual({ runId: "run-1", status: "running" });
		await expect(client.resumeRun("session.jsonl", started.runId, "resume")).resolves.toMatchObject({
			runId: "run-2",
			attempt: 2,
		});
		expect(commands).toEqual(["initialize", "run.start", "run.get", "run.cancel", "run.resume"]);
	});

	it("normalizes remote WebSocket bearer and TLS options", () => {
		const client = new RpcClient({
			transport: {
				type: "websocket",
				host: "remote.example",
				port: 4123,
				bearerToken: "token",
				tls: { caPath: "ca.pem" },
			},
		});
		expect((client as unknown as { resolveWebsocketOptions: () => unknown }).resolveWebsocketOptions()).toEqual({
			host: "remote.example",
			port: 4123,
			path: "/rpc",
			connectTimeoutMs: 10_000,
			bearerToken: "token",
			tls: { caPath: "ca.pem" },
		});
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

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	await closeServer(server);
	return address.port;
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
