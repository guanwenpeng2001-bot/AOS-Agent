import { PROTOCOL_VERSION } from "@aos-agent/protocol";
import { describe, expect, test } from "vitest";
import { AosClient, AosClientDisposedError } from "../src/index.ts";
import { attachSession, baseServerSnapshot, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("AosClient disposal", () => {
	test("connects through its ownership factory", async () => {
		const server = new MemoryByteServer();
		server.onMessage((message) => {
			if (message.type !== "hello") return;
			server.send({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "connection-1",
				snapshot: baseServerSnapshot,
			});
		});

		const client = await AosClient.connect({
			transportFactory: (handlers) => server.connect(handlers),
		});

		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("disconnects, invalidates child handles, and rejects pending requests", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachSession(client, server, sessionSnapshot("session-1"));
		const pending = client.listSessions();

		const firstDisposal = client.dispose();
		const secondDisposal = client.dispose();

		expect(secondDisposal).toBe(firstDisposal);
		expect(client.disposed).toBe(true);
		expect(client.connected).toBe(false);
		expect(handle.attached).toBe(false);
		await expect(pending).rejects.toBeInstanceOf(AosClientDisposedError);
		await expect(handle.prompt("after disposal")).rejects.toBeInstanceOf(AosClientDisposedError);
		await firstDisposal;
	});

	test("supports explicit async disposal", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);

		await client[Symbol.asyncDispose]();

		expect(client.disposed).toBe(true);
		expect(client.connectionState).toBe("disconnected");
	});
});
