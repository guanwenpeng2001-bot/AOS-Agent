import { stdin, stderr, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
	WORKER_PROTOCOL_MAX_FRAME_BYTES,
	serializeWorkerFrameLine,
	type OperationWorkerEventFrame,
} from "./core/worker-protocol.ts";
import {
	OperationWorkerRuntime,
	type WorkerRuntimeSandboxOperationProvider,
} from "./core/worker-runtime.ts";
import { attachJsonlLineReader, createJsonlLineWriter } from "./modes/rpc/jsonl.ts";

export interface WorkerEntryOptions {
	readonly provider: WorkerRuntimeSandboxOperationProvider;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly diagnostic?: Writable;
	readonly now?: () => string;
	readonly heartbeatIntervalMs?: number;
}

/**
 * Run the trusted worker transport with a provider supplied by the composition
 * root. This entry never loads provider code or configuration from RPC/env.
 */
export function runOperationWorkerProcess(options: WorkerEntryOptions): Promise<void> {
	const input = options.input ?? stdin;
	const output = options.output ?? stdout;
	const diagnostic = options.diagnostic ?? stderr;
	const writer = createJsonlLineWriter<OperationWorkerEventFrame>(output, {
		maxFrameBytes: WORKER_PROTOCOL_MAX_FRAME_BYTES,
	});
	let detachInput = (): void => undefined;
	let inputTail = Promise.resolve();
	let settled = false;
	let resolveRun: () => void = () => undefined;
	const run = new Promise<void>((resolve) => {
		resolveRun = resolve;
	});

	const settle = (): void => {
		if (settled) return;
		settled = true;
		detachInput();
		void writer.waitForDrain().catch(() => undefined).then(() => {
			writer.detach();
			resolveRun();
		});
	};

	const runtime = new OperationWorkerRuntime({
		provider: options.provider,
		emit: (frame) => writer.writeLine(serializeWorkerFrameLine(frame)),
		diagnostic: (line) => {
			try {
				diagnostic.write(line);
			} catch {
				// Stderr failure cannot alter the protocol stream.
			}
		},
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
		onClosed: settle,
	});

	detachInput = attachJsonlLineReader(
		input,
		(line) => {
			inputTail = inputTail.then(() => runtime.receiveLine(line));
		},
		{
			maxFrameBytes: WORKER_PROTOCOL_MAX_FRAME_BYTES,
			onError: () => runtime.failInput(),
			onEnd: () => {
				void inputTail.then(() => runtime.waitForIdle()).then(
					() => {
						runtime.close();
						settle();
					},
					() => runtime.failInput(),
				);
			},
		},
	);

	return run;
}

export const runWorkerEntry = runOperationWorkerProcess;
