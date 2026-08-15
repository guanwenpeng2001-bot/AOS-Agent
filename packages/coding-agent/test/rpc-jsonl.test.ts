import { Readable, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
	attachJsonlLineReader,
	createJsonlLineWriter,
	JsonlFrameError,
	serializeJsonLine,
} from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("round-trips a multi-record transcript across split UTF-8 chunks", async () => {
		const records = [
			{ id: "one", type: "response", text: "before é after" },
			{ id: "two", type: "event", text: "a\u2028b\u2029c" },
		];
		const transcript = records.map((record) => serializeJsonLine(record)).join("");
		const bytes = Buffer.from(transcript, "utf8");
		const chunks = Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1));
		const lines: string[] = [];
		const stream = Readable.from(chunks);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => lines.push(line));

		await done;
		expect(lines).toEqual(records.map((record) => JSON.stringify(record)));
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("bounds network input by UTF-8 bytes and reports oversized lines", async () => {
		const line = '{"text":"é"}';
		const errors: Error[] = [];
		const stream = Readable.from([Buffer.from(`${line}\n`, "utf8")]);
		const done = new Promise<void>((resolve) => stream.on("end", resolve));

		attachJsonlLineReader(stream, () => {}, {
			maxFrameBytes: Buffer.byteLength(`${line}\n`, "utf8") - 1,
			onError: (error) => errors.push(error),
		});
		await done;

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(JsonlFrameError);
	});

	test("serializes concurrent output in order", async () => {
		const chunks: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(String(chunk));
				callback();
			},
		});
		const writer = createJsonlLineWriter<{ sequence: number }>(stream);

		await Promise.all([writer.write({ sequence: 1 }), writer.write({ sequence: 2 })]);
		await writer.close();
		expect(chunks).toEqual(['{"sequence":1}\n', '{"sequence":2}\n']);
	});

	test("waits for drain before resolving backpressured output", async () => {
		let completeWrite: (() => void) | undefined;
		const stream = new Writable({
			highWaterMark: 1,
			write(_chunk, _encoding, callback) {
				completeWrite = () => callback();
			},
		});
		const writer = createJsonlLineWriter<{ sequence: number }>(stream);
		let settled = false;
		const pending = writer.write({ sequence: 1 }).then(() => {
			settled = true;
		});

		await vi.waitFor(() => expect(stream.writableNeedDrain).toBe(true));
		expect(settled).toBe(false);
		completeWrite?.();
		await pending;
		await writer.close();
	});

	test("stops the queue after a writable failure", async () => {
		let writes = 0;
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				writes++;
				callback(new Error("write failed"));
			},
		});
		const writer = createJsonlLineWriter<{ sequence: number }>(stream);

		await expect(writer.write({ sequence: 1 })).rejects.toThrow("write failed");
		await expect(writer.write({ sequence: 2 })).rejects.toThrow("write failed");
		expect(writes).toBe(1);
	});
});
