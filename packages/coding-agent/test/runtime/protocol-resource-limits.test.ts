import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { PassThrough, type Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
	BoundedProtocolWriter,
	type BoundedProtocolError,
} from "../../src/core/bounded-protocol.ts";
import { withRuntimeClock } from "../../src/core/runtime/clock.ts";
import {
	attachJsonlLineReader,
	createJsonlLineWriter,
	JsonlFrameError,
} from "../../src/modes/rpc/jsonl.ts";
import {
	createRpcTransport,
	type RpcTransportError,
} from "../../src/modes/rpc/rpc-transport.ts";
import { DeterministicClock } from "../support/deterministic-clock.ts";

interface ControlledWrite {
	readonly value: string;
	resolve(): void;
}

class ObservedValues<T> {
	readonly values: T[] = [];
	private readonly waiters = new Map<number, Set<() => void>>();

	push(value: T): void {
		this.values.push(value);
		for (const [length, waiters] of this.waiters) {
			if (this.values.length < length) continue;
			this.waiters.delete(length);
			for (const resolve of waiters) resolve();
		}
	}

	whenLength(length: number): Promise<void> {
		if (this.values.length >= length) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const waiters = this.waiters.get(length) ?? new Set<() => void>();
			waiters.add(resolve);
			this.waiters.set(length, waiters);
		});
	}
}

class ObservedClock extends DeterministicClock {
	private readonly pendingWaiters = new Set<() => void>();

	override setTimeout(
		callback: () => void,
		delayMs: number,
	): ReturnType<DeterministicClock["setTimeout"]> {
		const handle = super.setTimeout(callback, delayMs);
		for (const resolve of this.pendingWaiters) resolve();
		this.pendingWaiters.clear();
		return handle;
	}

	whenPending(): Promise<void> {
		if (this.pendingCount() > 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.pendingWaiters.add(resolve));
	}
}

interface TestCommand {
	readonly type: "close-race" | "flood";
}

interface TestOutput {
	readonly type: "event";
	readonly sequence: number;
	readonly payload?: string;
}

describe("bounded protocol writer", () => {
	test("admits exact byte and entry boundaries before failing closed", async () => {
		const byteClock = new DeterministicClock();
		const byteOperations = new ObservedValues<ControlledWrite>();
		const byteWriter = controlledWriter(byteOperations, byteClock, {
			maxPendingBytes: 4,
			maxPendingEntries: 3,
		});
		const exactBytes = byteWriter.write("1234");

		expect(byteWriter.pendingBytes).toBe(4);
		await expect(byteWriter.write("5")).rejects.toMatchObject({
			code: "protocol_pending_bytes_exceeded",
			actual: 5,
			limit: 4,
		});
		byteOperations.values[0].resolve();
		await exactBytes;
		await expect(byteWriter.close()).rejects.toMatchObject({ code: "protocol_pending_bytes_exceeded" });
		expect(byteWriter.pendingBytes).toBe(0);
		expect(byteClock.pendingCount()).toBe(0);

		const entryClock = new DeterministicClock();
		const entryOperations = new ObservedValues<ControlledWrite>();
		const entryWriter = controlledWriter(entryOperations, entryClock, {
			maxPendingBytes: 100,
			maxPendingEntries: 2,
		});
		const first = entryWriter.write("a");
		const second = entryWriter.write("b");

		expect(entryWriter.pendingEntries).toBe(2);
		await expect(entryWriter.write("c")).rejects.toMatchObject({
			code: "protocol_pending_entries_exceeded",
			actual: 3,
			limit: 2,
		});
		entryOperations.values[0].resolve();
		await first;
		await entryOperations.whenLength(2);
		entryOperations.values[1].resolve();
		await second;
		await expect(entryWriter.close()).rejects.toMatchObject({ code: "protocol_pending_entries_exceeded" });
		expect(entryWriter.pendingEntries).toBe(0);
		expect(entryClock.pendingCount()).toBe(0);
	});

	test("drains accepted entries FIFO before finalization and rejects a close race", async () => {
		const clock = new DeterministicClock();
		const operations = new ObservedValues<ControlledWrite>();
		const trace: string[] = [];
		const writer = new BoundedProtocolWriter<string>({
			maxPendingBytes: 32,
			maxPendingEntries: 3,
			drainTimeoutMs: 50,
			clock,
			byteLength: (value) => Buffer.byteLength(value, "utf8"),
			write: (value) =>
				new Promise<void>((resolve) => {
					trace.push(`write:${value}`);
					operations.push({ value, resolve });
				}),
			finalize: () => {
				trace.push("finalize");
			},
		});
		const accepted = [writer.write("one"), writer.write("two"), writer.write("three")];
		const closing = writer.close();

		await expect(writer.write("late")).rejects.toMatchObject({ code: "protocol_closed" });
		expect(trace).toEqual(["write:one"]);
		for (let index = 0; index < accepted.length; index++) {
			operations.values[index].resolve();
			await accepted[index];
			if (index + 1 < accepted.length) {
				await operations.whenLength(index + 2);
			}
		}
		await closing;

		expect(trace).toEqual(["write:one", "write:two", "write:three", "finalize"]);
		expect(writer.state).toBe("closed");
		expect(clock.pendingCount()).toBe(0);
	});

	test("settles a non-cooperative write at the total drain deadline", async () => {
		const clock = new DeterministicClock();
		let activeSignal: AbortSignal | undefined;
		const writer = new BoundedProtocolWriter<string>({
			maxPendingBytes: 16,
			maxPendingEntries: 2,
			drainTimeoutMs: 25,
			clock,
			byteLength: (value) => Buffer.byteLength(value, "utf8"),
			write: (_value, signal) => {
				activeSignal = signal;
				return new Promise<void>(() => {});
			},
		});
		const pending = writer.write("blocked");
		const closing = writer.close();

		expect(clock.pendingCount()).toBe(1);
		clock.advanceBy(25);
		await expect(pending).rejects.toMatchObject({ code: "protocol_drain_timeout" });
		await expect(closing).rejects.toMatchObject({ code: "protocol_drain_timeout" });

		expect(activeSignal?.aborted).toBe(true);
		expect(writer.state).toBe("failed");
		expect(writer.pendingEntries).toBe(0);
		expect(clock.pendingCount()).toBe(0);
	});

	test("isolates a throwing writer and a throwing error observer without unhandled rejections", async () => {
		const reported: Error[] = [];
		const writer = new BoundedProtocolWriter<string>({
			maxPendingBytes: 16,
			maxPendingEntries: 2,
			drainTimeoutMs: 25,
			byteLength: (value) => Buffer.byteLength(value, "utf8"),
			write: () => {
				throw new Error("writer exploded");
			},
			onError: (error) => {
				reported.push(error);
				throw new Error("observer exploded");
			},
		});
		const first = writer.write("a");
		const second = writer.write("b");

		const settlements = await Promise.allSettled([first, second]);
		expect(settlements).toEqual([
			expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "protocol_write_failed" }) }),
			expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "protocol_write_failed" }) }),
		]);
		expect(reported).toHaveLength(1);
		expect(reported[0].message).toContain("writer exploded");
		expect(writer.pendingEntries).toBe(0);
		void writer.write("ignored");
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
});

describe("bounded JSONL resources", () => {
	test("accepts the exact frame boundary and releases listeners after an oversized undelimited frame", async () => {
		const exact = new PassThrough();
		const lines: string[] = [];
		const ended = new Promise<void>((resolve) => {
			attachJsonlLineReader(exact, (line) => lines.push(line), { maxFrameBytes: 8, onEnd: resolve });
		});
		exact.end('{"t":1}\n');
		await ended;

		expect(lines).toEqual(['{"t":1}']);
		expect(exact.listenerCount("data")).toBe(0);
		expect(exact.listenerCount("end")).toBe(0);

		const oversized = new PassThrough();
		const errors: Error[] = [];
		const failed = new Promise<void>((resolve) => {
			attachJsonlLineReader(oversized, () => {}, {
				maxFrameBytes: 8,
				onError: (error) => {
					errors.push(error);
					resolve();
				},
			});
		});
		oversized.write("123456789");
		await failed;

		expect(errors).toEqual([expect.any(JsonlFrameError)]);
		expect(oversized.listenerCount("data")).toBe(0);
		expect(oversized.listenerCount("end")).toBe(0);
		expect(oversized.listenerCount("error")).toBe(0);
		oversized.end();
	});

	test("preserves admitted JSONL records through an exact pending-byte boundary", async () => {
		const chunks: string[] = [];
		const callbacks = new ObservedValues<(error?: Error | null) => void>();
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(String(chunk));
				callbacks.push(callback);
			},
		});
		const writer = createJsonlLineWriter(stream, {
			maxFrameBytes: 16,
			maxPendingWriteBytes: 4,
			maxPendingWriteEntries: 2,
			drainTimeoutMs: 100,
		});
		const first = writer.writeLine("a\n");
		const second = writer.writeLine("b\n");

		await expect(writer.writeLine("c\n")).rejects.toMatchObject({ code: "protocol_pending_bytes_exceeded" });
		callbacks.values[0]();
		await first;
		await callbacks.whenLength(2);
		callbacks.values[1]();
		await second;
		await expect(writer.close()).rejects.toMatchObject({ code: "protocol_pending_bytes_exceeded" });

		expect(chunks).toEqual(["a\n", "b\n"]);
		writer.detach();
		expect(stream.listenerCount("error")).toBe(0);
		expect(stream.listenerCount("close")).toBe(0);
		expect(stream.listenerCount("drain")).toBe(0);
	});
});

describe.sequential("RPC protocol drain", () => {
	test("rejects output beyond the exact pending-entry boundary without dropping admitted records", async () => {
		let writes: Promise<void>[] = [];
		let dispatchStarted!: () => void;
		const dispatched = new Promise<void>((resolve) => {
			dispatchStarted = resolve;
		});
		const errors: RpcTransportError[] = [];
		const transport = createRpcTransport<TestCommand, TestOutput>({
			address: { transport: "tcp", host: "127.0.0.1", port: await getAvailablePort() },
			maxPendingWriteBytes: 1024,
			maxPendingWriteEntries: 2,
			dispatch: (_command, sink) => {
				writes = [1, 2, 3].map((sequence) => sink.send({ type: "event", sequence }));
				dispatchStarted();
			},
			onError: (error) => errors.push(error),
		});
		await transport.start();
		const peer = createConnection({ host: transport.address!.host, port: transport.address!.port });
		peer.on("error", () => {});
		const output = collectJsonlRecords<TestOutput>(peer, 2);
		try {
			await once(peer, "connect");
			peer.write('{"type":"close-race"}\n');
			await dispatched;
			const settlements = await Promise.allSettled(writes);

			expect(settlements.slice(0, 2).every((result) => result.status === "fulfilled")).toBe(true);
			expect(settlements[2]).toMatchObject({
				status: "rejected",
				reason: expect.objectContaining({ code: "rpc_transport_pending_write_limit" }),
			});
			await output.received;
			expect(output.records.map((record) => record.sequence)).toEqual([1, 2]);
			expect(errors.some((error) => error.code === "rpc_transport_pending_write_limit")).toBe(true);
		} finally {
			output.detach();
			if (!peer.destroyed) peer.destroy();
			await transport.close();
		}
	});

	test("drains normal control output in FIFO order and rejects writes racing close", async () => {
		let accepted: Promise<void>[] = [];
		let closing: Promise<void> | undefined;
		let late: Promise<void> | undefined;
		let dispatchStarted!: () => void;
		const dispatched = new Promise<void>((resolve) => {
			dispatchStarted = resolve;
		});
		const transport = createRpcTransport<TestCommand, TestOutput>({
			address: { transport: "tcp", host: "127.0.0.1", port: await getAvailablePort() },
			dispatch: (_command, sink) => {
				accepted = [
					sink.send({ type: "event", sequence: 1 }),
					sink.send({ type: "event", sequence: 2 }),
				];
				closing = sink.close();
				late = sink.send({ type: "event", sequence: 3 });
				void sink.send({ type: "event", sequence: 4 });
				dispatchStarted();
			},
		});
		await transport.start();
		const peer = createConnection({ host: transport.address!.host, port: transport.address!.port });
		peer.on("error", () => {});
		const output = collectJsonlRecords<TestOutput>(peer, 2);
		try {
			await once(peer, "connect");
			peer.write('{"type":"close-race"}\n');
			await dispatched;
			await expect(late).rejects.toMatchObject({ code: "rpc_transport_closed" });
			await Promise.all(accepted);
			await closing;
			await output.received;
			expect(output.records.map((record) => record.sequence)).toEqual([1, 2]);
		} finally {
			output.detach();
			if (!peer.destroyed) peer.destroy();
			await transport.close();
		}
	});

	test("times out a non-reading peer, settles pending writes, and clears the drain timer", async () => {
		const clock = new ObservedClock();
		const errors: RpcTransportError[] = [];
		let writes: Promise<void>[] = [];
		let closing: Promise<void> | undefined;
		let dispatchStarted!: () => void;
		const dispatched = new Promise<void>((resolve) => {
			dispatchStarted = resolve;
		});
		const transport = createRpcTransport<TestCommand, TestOutput>(
			withRuntimeClock(
				{
					address: { transport: "tcp", host: "127.0.0.1", port: await getAvailablePort() },
					maxFrameBytes: 1024 * 1024,
					maxPendingWriteBytes: 8 * 1024 * 1024,
					maxPendingWriteEntries: 8,
					drainTimeoutMs: 25,
					dispatch: (_command: TestCommand, sink) => {
						writes = Array.from({ length: 8 }, (_, sequence) =>
							sink.send({ type: "event", sequence, payload: "x".repeat(900_000) }),
						);
						closing = transport.close();
						dispatchStarted();
					},
					onError: (error: RpcTransportError) => errors.push(error),
				},
				clock,
			),
		);
		await transport.start();
		const peer = createConnection({ host: transport.address!.host, port: transport.address!.port });
		peer.on("error", () => {});
		try {
			await once(peer, "connect");
			peer.pause();
			peer.write('{"type":"flood"}\n');
			await dispatched;
			await clock.whenPending();
			expect(clock.pendingCount()).toBeGreaterThan(0);
			clock.advanceBy(25);
			await closing;
			const settlements = await Promise.allSettled(writes);

			expect(settlements.some((result) => result.status === "rejected")).toBe(true);
			expect(
				settlements.some(
					(result) =>
						result.status === "rejected" &&
						(result.reason as BoundedProtocolError | RpcTransportError).code === "rpc_transport_drain_timeout",
				),
			).toBe(true);
			expect(errors.some((error) => error.code === "rpc_transport_drain_timeout")).toBe(true);
			expect(transport.activeConnection).toBeUndefined();
			expect(clock.pendingCount()).toBe(0);
		} finally {
			if (!peer.destroyed) peer.destroy();
			await transport.close();
		}
	});
});

function collectJsonlRecords<T>(
	stream: Readable,
	expectedCount: number,
): { readonly records: T[]; readonly received: Promise<void>; readonly detach: () => void } {
	const records: T[] = [];
	let resolveReceived!: () => void;
	const received = new Promise<void>((resolve) => {
		resolveReceived = resolve;
	});
	const detach = attachJsonlLineReader(stream, (line) => {
		records.push(JSON.parse(line) as T);
		if (records.length === expectedCount) resolveReceived();
	});
	return { records, received, detach };
}

function controlledWriter(
	operations: ObservedValues<ControlledWrite>,
	clock: DeterministicClock,
	limits: { readonly maxPendingBytes: number; readonly maxPendingEntries: number },
): BoundedProtocolWriter<string> {
	return new BoundedProtocolWriter<string>({
		...limits,
		drainTimeoutMs: 100,
		clock,
		byteLength: (value) => Buffer.byteLength(value, "utf8"),
		write: (value) =>
			new Promise<void>((resolve) => {
				operations.push({ value, resolve });
			}),
	});
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
