import { BoundedProtocolWriter, DEFAULT_BOUNDED_PROTOCOL_LIMITS } from "./bounded-protocol.ts";

interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string, signal: AbortSignal): Promise<void> {
	while (true) {
		if (signal.aborted) throw abortReason(signal);
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					if (error === undefined) resolve();
					else reject(error);
				};
				const onAbort = (): void => finish(abortReason(signal));
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					getRawStdoutWrite()(text, (error) => {
						finish(error ?? undefined);
					});
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, RAW_STDOUT_RETRY_DELAY_MS);
				const onAbort = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					reject(abortReason(signal));
				};
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
	}
}

const rawStdoutProtocol = new BoundedProtocolWriter<string>({
	...DEFAULT_BOUNDED_PROTOCOL_LIMITS,
	byteLength: (text) => Buffer.byteLength(text, "utf8"),
	write: (text, signal) => writeRawStdoutChunk(text, signal),
});

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	const pending = rawStdoutProtocol.write(text);
	void pending.catch(async () => {
		await rawStdoutProtocol.close().catch(() => {});
		try {
			process.exit(1);
		} catch {
			// Tests and embedders may replace process.exit with a throwing sentinel.
		}
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	await rawStdoutProtocol.waitForDrain();
}

export async function flushRawStdout(): Promise<void> {
	const marker = rawStdoutProtocol.write("");
	await Promise.all([marker, rawStdoutProtocol.waitForDrain()]);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Raw stdout write aborted");
}
