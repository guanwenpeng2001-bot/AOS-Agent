import type {
	SandboxOperationRequest,
	SandboxOperationResult,
} from "../../../src/core/sandbox.ts";
import {
	GondolinAdapterError,
	type GondolinAdapterErrorCode,
	createGondolinPathMapper,
	type GondolinPathMapper,
} from "./path-mapper.ts";
import type { GondolinOperationContext } from "./filesystem-operations.ts";
import { gondolinExecResult, type GondolinGuestExecProcess, type GondolinVmLike } from "./vm-types.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_SHELL_PATH = "/bin/sh";

export type GondolinProcessVm = Pick<GondolinVmLike, "exec">;

export interface GondolinProcessOperationOptions {
	readonly shellPath?: string;
	readonly maxOutputBytes?: number;
	readonly onSideEffectStart?: () => void;
}

export interface GondolinProcessOperations {
	readonly execute: (request: SandboxOperationRequest) => Promise<SandboxOperationResult>;
	readonly spawn: (request: SandboxOperationRequest) => Promise<SandboxOperationResult>;
}

export type GondolinProcessErrorCode = "aborted" | "timeout" | "process_failed";

export class GondolinProcessError extends GondolinAdapterError {
	readonly processCode: GondolinProcessErrorCode;
	readonly timeoutMs?: number;

	constructor(code: GondolinProcessErrorCode, timeoutMs?: number) {
		const adapterCode: GondolinAdapterErrorCode = "sandbox_unavailable";
		const message = code === "aborted" ? "aborted" : code === "timeout" ? `timeout:${(timeoutMs ?? 0) / 1000}` : "Guest process failed.";
		super(adapterCode, message);
		this.name = "GondolinProcessError";
		this.processCode = code;
		this.timeoutMs = timeoutMs;
	}
}

function safeProcessRequestError(): GondolinAdapterError {
	return new GondolinAdapterError("policy_violation", "The guest process request is invalid.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GondolinProcessError("aborted");
}

function positiveLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function sanitizeEnvironment(environment: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const sanitized: Record<string, string> = {};
	if (environment === undefined) return sanitized;
	for (const [key, value] of Object.entries(environment)) {
		if (typeof value === "string") sanitized[key] = value;
	}
	return sanitized;
}

class OutputCollector {
	private readonly maxBytes: number;
	private bytes = 0;
	private readonly stdoutChunks: Buffer[] = [];
	private readonly stderrChunks: Buffer[] = [];

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(stream: "stdout" | "stderr", data: Buffer): Buffer | undefined {
		const remaining = this.maxBytes - this.bytes;
		if (remaining <= 0) return undefined;
		const accepted = data.byteLength <= remaining ? data : data.subarray(0, remaining);
		this.bytes += accepted.byteLength;
		if (stream === "stdout") this.stdoutChunks.push(accepted);
		else this.stderrChunks.push(accepted);
		return accepted;
	}

	result(): { readonly stdout: Buffer; readonly stderr: Buffer } {
		return {
			stdout: Buffer.concat(this.stdoutChunks),
			stderr: Buffer.concat(this.stderrChunks),
		};
	}
}

function commandForRequest(
	request: SandboxOperationRequest,
	shellPath: string,
): string[] {
	if (typeof request.command !== "string" || request.command.length === 0) throw safeProcessRequestError();
	if (request.args !== undefined && request.args.length > 0) {
		return [request.command, ...request.args];
	}
	return [shellPath, "-lc", request.command];
}

function operationTimeout(request: SandboxOperationRequest): number | undefined {
	if (request.timeoutMs === undefined) return undefined;
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw safeProcessRequestError();
	return Math.floor(request.timeoutMs);
}

export function createGondolinProcessOperations(
	vm: GondolinProcessVm,
	pathMapper: GondolinPathMapper,
	options: GondolinProcessOperationOptions | string = {},
): GondolinProcessOperations {
	const resolvedOptions = typeof options === "string" ? { shellPath: options } : options;
	const shellPath = resolvedOptions.shellPath ?? DEFAULT_SHELL_PATH;
	const maxOutputBytes = positiveLimit(resolvedOptions.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);

	const spawn = async (request: SandboxOperationRequest): Promise<SandboxOperationResult> => {
		throwIfAborted(request.signal);
		const guestCwd = await pathMapper.toGuestPath(request.cwd ?? pathMapper.workspaceRoot, { allowMissing: false });
		const command = commandForRequest(request, shellPath);
		const timeoutMs = operationTimeout(request);
		const controller = new AbortController();
		let timedOut = false;
		let process: GondolinGuestExecProcess | undefined;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const collector = new OutputCollector(maxOutputBytes);
		const onAbort = (): void => {
			controller.abort();
		};

		if (request.signal?.aborted) throw new GondolinProcessError("aborted");
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
		}

		try {
			resolvedOptions.onSideEffectStart?.();
			process = vm.exec(command, {
				cwd: guestCwd,
				env: sanitizeEnvironment(request.env),
				signal: controller.signal,
				stdout: "pipe",
				stderr: "pipe",
			});
			for await (const chunk of process.output()) {
				const accepted = collector.push(chunk.stream, chunk.data);
				if (accepted !== undefined && request.onData !== undefined) request.onData(accepted);
			}
			if (timedOut) throw new GondolinProcessError("timeout", timeoutMs);
			throwIfAborted(request.signal);
			const result = await gondolinExecResult(process);
			if (timedOut) throw new GondolinProcessError("timeout", timeoutMs);
			throwIfAborted(request.signal);
			const output = collector.result();
			return {
				exitCode: result.exitCode,
				stdout: output.stdout,
				stderr: output.stderr,
				...(result.signal === undefined ? {} : { killed: true }),
			};
		} catch (error) {
			if (process !== undefined) await gondolinExecResult(process).catch(() => undefined);
			if (timedOut) throw new GondolinProcessError("timeout", timeoutMs);
			if (request.signal?.aborted) throw new GondolinProcessError("aborted");
			if (error instanceof GondolinProcessError) throw error;
			throw new GondolinProcessError("process_failed");
		} finally {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			request.signal?.removeEventListener("abort", onAbort);
		}
	};

	return { execute: spawn, spawn };
}

export async function executeGondolinProcessOperation(
	vm: GondolinProcessVm,
	pathMapper: GondolinPathMapper,
	request: SandboxOperationRequest,
	options?: GondolinProcessOperationOptions | string,
): Promise<SandboxOperationResult> {
	return createGondolinProcessOperations(vm, pathMapper, options ?? {}).execute(request);
}

/** Execute one process request through the provider's guest-only context. */
export async function executeProcessOperation(
	context: GondolinOperationContext,
	request: SandboxOperationRequest,
	options?: GondolinProcessOperationOptions | string,
): Promise<SandboxOperationResult> {
	const pathMapper = context.pathMapper ?? createGondolinPathMapper({
		workspaceRoot: context.workspaceRoot,
		...context.pathMapperOptions,
	});
	return executeGondolinProcessOperation(context.vm, pathMapper, request, {
		...(typeof options === "string" ? { shellPath: options } : options),
		onSideEffectStart: context.onSideEffectStart,
	});
}
