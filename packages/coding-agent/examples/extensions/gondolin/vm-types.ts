export const GONDOLIN_GUEST_WORKSPACE = "/workspace";

export interface GondolinGuestExecChunk {
	readonly stream: "stdout" | "stderr";
	readonly data: Buffer;
}

export interface GondolinGuestExecResult {
	readonly exitCode: number;
	readonly signal?: number;
	readonly stdout?: string | Buffer;
	readonly stderr?: string | Buffer;
}

export interface GondolinGuestExecProcess {
	readonly result?: Promise<GondolinGuestExecResult>;
	then?: Promise<GondolinGuestExecResult>["then"];
	output(): AsyncIterable<GondolinGuestExecChunk>;
}

export interface GondolinGuestFilesystem {
	access(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
	mkdir(pathName: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
	listDir(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<string[]>;
	stat(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<{ isDirectory(): boolean }>;
	readFile(pathName: string, options: { readonly encoding: null; readonly signal?: AbortSignal }): Promise<Buffer>;
	readFile(pathName: string, options: { readonly encoding: BufferEncoding; readonly signal?: AbortSignal }): Promise<string>;
	writeFile(
		pathName: string,
		data: string | Buffer,
		options?: { readonly encoding?: BufferEncoding; readonly signal?: AbortSignal },
	): Promise<void>;
}

/**
 * The small part of Gondolin's VM surface used by the provider adapter.
 * The shape is structural so contract tests can inject a fake VM.
 */
export interface GondolinVmLike {
	readonly id: string;
	readonly fs: GondolinGuestFilesystem;
	exec(
		command: string | string[],
		options?: {
			readonly cwd?: string;
			readonly env?: Record<string, string>;
			readonly signal?: AbortSignal;
			readonly stdout?: "pipe";
			readonly stderr?: "pipe";
		},
	): GondolinGuestExecProcess;
	close(): Promise<void>;
}

export interface GondolinVmFactoryOptions {
	readonly workspaceRoot: string;
	readonly sessionLabel?: string;
	readonly signal?: AbortSignal;
}

export type GondolinVmFactory = (options: GondolinVmFactoryOptions) => Promise<GondolinVmLike>;

function abortError(): DOMException {
	return new DOMException("Sandbox operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

/**
 * Close a VM at most once, including when provider cleanup races with another
 * cleanup path. The promise is retained so concurrent callers observe the
 * same completion or failure.
 */
const closePromises = new WeakMap<GondolinVmLike, Promise<void>>();

export function closeGondolinVm(vm: GondolinVmLike): Promise<void> {
	const existing = closePromises.get(vm);
	if (existing !== undefined) return existing;
	const closing = Promise.resolve().then(() => vm.close());
	closePromises.set(vm, closing);
	return closing;
}

export function gondolinExecResult(process: GondolinGuestExecProcess): Promise<GondolinGuestExecResult> {
	if (typeof process.then === "function") return Promise.resolve(process as PromiseLike<GondolinGuestExecResult>);
	if (process.result !== undefined) return process.result;
	return Promise.reject(new Error("Guest process result is unavailable."));
}

/**
 * Probe the fixed guest shell used by the operation adapters. The probe does
 * not expose output and intentionally uses no host environment.
 */
export async function probeGondolinVm(vm: GondolinVmLike, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const result = await gondolinExecResult(vm.exec(["/bin/sh", "-lc", "true"], { signal }));
	if (result.exitCode !== 0) throw new Error("Guest shell probe failed.");
	throwIfAborted(signal);
}
