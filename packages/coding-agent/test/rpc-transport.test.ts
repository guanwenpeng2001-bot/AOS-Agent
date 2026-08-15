import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import {
	createRpcTransport,
	type RpcTransport,
	type RpcTransportSink,
	type RpcTransportError,
} from "../src/modes/rpc/rpc-transport.ts";
import type { TcpRpcAddress } from "../src/modes/rpc/rpc-transport-address.ts";

interface TestCommand {
	readonly type: "echo" | "ordered";
	readonly value?: string;
}

interface TestOutput {
	readonly type: "response" | "error";
	readonly value?: string | number;
}

interface Peer {
	readonly socket: Socket;
	readonly records: unknown[];
	readonly nextRecord: () => Promise<unknown>;
}

const transports = new Set<RpcTransport<TestCommand, TestOutput>>();
const peers = new Set<Peer>();

afterEach(async () => {
	await Promise.all([...transports].map((transport) => transport.close()));
	const pendingClose = [...peers]
		.filter((peer) => !peer.socket.destroyed)
		.map((peer) => once(peer.socket, "close").catch(() => {}));
	for (const peer of peers) {
		if (!peer.socket.destroyed) peer.socket.destroy();
	}
	await Promise.all(pendingClose);
	transports.clear();
	peers.clear();
});

describe("RPC TCP transport", () => {
	test.each([0, 65_536])("rejects listener port %s", (port) => {
		try {
			createRpcTransport({
				address: { transport: "tcp", host: "127.0.0.1", port },
				dispatch: () => undefined,
			});
			throw new Error("expected address validation to fail");
		} catch (error: unknown) {
			expect(error).toMatchObject({ code: "rpc_transport_address_invalid" });
		}
	});

	test("reports a stable bind failure when the listener port is occupied", async () => {
		const port = await getAvailablePort();
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen({ host: "127.0.0.1", port }, () => resolve());
		});
		const errors: RpcTransportError[] = [];
		const transport = createRpcTransport<TestCommand, TestOutput>({
			address: { transport: "tcp", host: "127.0.0.1", port },
			dispatch: () => undefined,
			onError: (error) => errors.push(error),
		});
		transports.add(transport);

		await expect(transport.start()).rejects.toMatchObject({ code: "rpc_transport_bind_failed" });
		expect(errors).toEqual([expect.objectContaining({ code: "rpc_transport_bind_failed" })]);
		await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
	});

	test("dispatches typed commands and releases the active connection on close", async () => {
		const dispatched: TestCommand[] = [];
		const transport = await makeTransport((command, sink) => {
			dispatched.push(command);
			return sink.send({ type: "response", value: command.value });
		});
		await transport.start();

		const first = await connectPeer(transport.address!);
		await writeRecord(first.socket, { type: "echo", value: "first" });
		expect(await first.nextRecord()).toEqual({ type: "response", value: "first" });
		expect(dispatched).toEqual([{ type: "echo", value: "first" }]);

		first.socket.destroy();
		await vi.waitFor(() => expect(transport.activeConnection).toBeUndefined());

		const second = await connectPeer(transport.address!);
		await writeRecord(second.socket, { type: "echo", value: "second" });
		expect(await second.nextRecord()).toEqual({ type: "response", value: "second" });
	});

	test("dispatches every record in one network chunk with CRLF and Unicode payloads", async () => {
		const dispatched: TestCommand[] = [];
		const transport = await makeTransport((command, sink) => {
			dispatched.push(command);
			return sink.send({ type: "response", value: command.value });
		});
		await transport.start();
		const peer = await connectPeer(transport.address!);

		peer.socket.write(
			`${JSON.stringify({ type: "echo", value: "a\u2028b\u2029c" })}\r\n${JSON.stringify({ type: "echo", value: "second" })}\n`,
		);

		expect(await peer.nextRecord()).toEqual({ type: "response", value: "a\u2028b\u2029c" });
		expect(await peer.nextRecord()).toEqual({ type: "response", value: "second" });
		expect(dispatched).toEqual([
			{ type: "echo", value: "a\u2028b\u2029c" },
			{ type: "echo", value: "second" },
		]);
	});

	test("rejects a second control connection before invoking its dispatcher", async () => {
		let dispatchCount = 0;
		const connectionErrors: RpcTransportError[] = [];
		const transport = await makeTransport(
			(_command, sink) => {
				dispatchCount++;
				return sink.send({ type: "response", value: "ok" });
			},
			{ onConnectionError: (error) => connectionErrors.push(error) },
		);
		await transport.start();
		const first = await connectPeer(transport.address!);
		const second = await connectPeer(transport.address!);

		expect(await second.nextRecord()).toEqual({
			type: "error",
			error: { code: "rpc_transport_connection_busy", message: "Another control connection is active" },
		});
		await once(second.socket, "close");
		expect(connectionErrors).toEqual([expect.objectContaining({ code: "rpc_transport_connection_busy" })]);

		await writeRecord(first.socket, { type: "echo" });
		expect(await first.nextRecord()).toEqual({ type: "response", value: "ok" });
		expect(dispatchCount).toBe(1);
	});

	test("sends a bounded-frame transport error and closes the connection", async () => {
		const errors: RpcTransportError[] = [];
		let dispatchCount = 0;
		const transport = await makeTransport(
			(_command, sink) => {
				dispatchCount++;
				return sink.send({ type: "response", value: "unexpected" });
			},
			{ maxFrameBytes: 128, onError: (error) => errors.push(error) },
		);
		await transport.start();
		const peer = await connectPeer(transport.address!);

		await writeRecord(peer.socket, { type: "echo", value: "x".repeat(200) });
		expect(await peer.nextRecord()).toMatchObject({
			type: "error",
			error: { code: "rpc_transport_frame_too_large" },
		});
		await once(peer.socket, "close");
		expect(dispatchCount).toBe(0);
		expect(errors).toEqual([expect.objectContaining({ code: "rpc_transport_frame_too_large" })]);
	});

	test("serializes concurrent sink output", async () => {
		const transport = await makeTransport(async (_command, sink) => {
			await Promise.all([sink.send({ type: "response", value: 1 }), sink.send({ type: "response", value: 2 })]);
		});
		await transport.start();
		const peer = await connectPeer(transport.address!);

		await writeRecord(peer.socket, { type: "ordered" });
		expect(await peer.nextRecord()).toEqual({ type: "response", value: 1 });
		expect(await peer.nextRecord()).toEqual({ type: "response", value: 2 });
	});
});

async function makeTransport(
	dispatch: (command: TestCommand, sink: RpcTransportSink<TestOutput>) => void | Promise<void>,
	options: {
		maxFrameBytes?: number;
		onError?: (error: RpcTransportError) => void;
		onConnectionError?: (error: RpcTransportError) => void;
	} = {},
): Promise<RpcTransport<TestCommand, TestOutput>> {
	const transport = createRpcTransport<TestCommand, TestOutput>({
		address: { transport: "tcp", host: "127.0.0.1", port: await getAvailablePort() },
		dispatch,
		...options,
	});
	transports.add(transport);
	return transport;
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

async function connectPeer(address: TcpRpcAddress): Promise<Peer> {
	const socket = createConnection({ host: address.host, port: address.port });
	await once(socket, "connect");
	const records: unknown[] = [];
	const waiters: Array<(record: unknown) => void> = [];
	attachJsonlLineReader(socket, (line) => {
		const record = JSON.parse(line) as unknown;
		const waiter = waiters.shift();
		if (waiter) waiter(record);
		else records.push(record);
	});
	const peer: Peer = {
		socket,
		records,
		nextRecord: () => {
			const record = records.shift();
			if (record !== undefined) return Promise.resolve(record);
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
	peers.add(peer);
	return peer;
}

function writeRecord(socket: Socket, value: unknown): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			socket.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve()));
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
