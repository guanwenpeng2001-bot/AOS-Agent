import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import type { ExternalConnectorResolvedTarget } from "../target-config.ts";
import type { ExternalConnectorProcessChannel, ExternalConnectorProcessController } from "../supervisor.ts";
import type {
	PrivateClaudeProcessBridge,
	PrivateClaudeSpawnedProcess,
	PrivateClaudeSpawnOptions,
} from "./claude.ts";

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_KEYS = 256;
const SENSITIVE_ENVIRONMENT_KEY = /(auth|credential|password|secret|token|api_?key)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeMessage(channel: ExternalConnectorProcessChannel, value: unknown): void {
	channel.writeLine(JSON.stringify(value));
}

class ContainedClaudeProcess extends EventEmitter implements PrivateClaudeSpawnedProcess {
	readonly stdin: Writable;
	readonly stdout = new PassThrough();
	#killed = false;
	#exitCode: number | null = null;
	#signalCode: NodeJS.Signals | null = null;
	#settled = false;
	readonly #channel: ExternalConnectorProcessChannel;

	constructor(channel: ExternalConnectorProcessChannel, launch: {
		readonly command: string;
		readonly args: readonly string[];
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
	}, signal: AbortSignal) {
		super();
		this.#channel = channel;
		this.stdin = new Writable({
			write(chunk: Buffer | string, _encoding, callback) {
				try {
					const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
						writeMessage(channel, {
							type: "stdin",
							data: bytes.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64"),
						});
					}
					callback();
				} catch (error) {
					callback(error instanceof Error ? error : new Error("Claude bridge stdin failed"));
				}
			},
			final(callback) {
				try {
					writeMessage(channel, { type: "stdin_end" });
					callback();
				} catch (error) {
					callback(error instanceof Error ? error : new Error("Claude bridge stdin close failed"));
				}
			},
		});
		writeMessage(channel, { type: "launch", ...launch });
		const abort = (): void => {
			this.kill("SIGTERM");
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void this.#read(channel).finally(() => signal.removeEventListener("abort", abort));
	}

	get killed(): boolean {
		return this.#killed;
	}

	get exitCode(): number | null {
		return this.#exitCode;
	}

	get signalCode(): NodeJS.Signals | null {
		return this.#signalCode;
	}

	kill(signal: NodeJS.Signals): boolean {
		if (this.#settled) return false;
		this.#killed = true;
		try {
			writeMessage(this.#channel, { type: "kill", signal });
			return true;
		} catch {
			return false;
		}
	}

	async #read(channel: ExternalConnectorProcessChannel): Promise<void> {
		try {
			for (;;) {
				const line = await channel.readLine();
				if (line === undefined) throw new Error("Claude bridge process channel closed");
				const message: unknown = JSON.parse(line);
				if (!isRecord(message) || typeof message.type !== "string") throw new Error("Claude bridge response is invalid");
				if (message.type === "stdout" && typeof message.data === "string") {
					this.stdout.write(Buffer.from(message.data, "base64"));
					continue;
				}
				if (message.type === "error") throw new Error("Claude Code process failed to start");
				if (
					message.type !== "exit" ||
					(message.code !== null && (!Number.isSafeInteger(message.code) || (message.code as number) < 0)) ||
					(message.signal !== null && typeof message.signal !== "string")
				) throw new Error("Claude bridge response is invalid");
				this.#settled = true;
				this.#exitCode = message.code as number | null;
				this.#signalCode = message.signal as NodeJS.Signals | null;
				this.stdout.end();
				this.emit("exit", this.#exitCode, this.#signalCode);
				return;
			}
		} catch {
			if (this.#settled) return;
			this.#settled = true;
			this.stdout.destroy();
			this.emit("error", new Error("Claude Code supervised process bridge failed"));
		}
	}
}

export class ProductionClaudeProcessBridge implements PrivateClaudeProcessBridge {
	readonly #controller: ExternalConnectorProcessController;
	readonly #target: ExternalConnectorResolvedTarget;

	constructor(controller: ExternalConnectorProcessController, target: ExternalConnectorResolvedTarget) {
		this.#controller = controller;
		this.#target = target;
	}

	spawn(
		reference: { readonly supervisorRef: string; readonly operationNonce: string },
		options: PrivateClaudeSpawnOptions,
	): PrivateClaudeSpawnedProcess {
		const channel = this.#controller.channelFor?.(reference);
		if (channel === undefined) throw new TypeError("Claude Code supervised process channel is unavailable");
		const command = realpathSync(options.command);
		const executable = realpathSync(this.#target.executablePath);
		const cwd = realpathSync(options.cwd ?? this.#target.cwd);
		if (
			command !== executable ||
			cwd !== realpathSync(this.#target.cwd) ||
			options.args.length > MAX_ARGUMENTS ||
			options.args.some((argument) => argument.includes("\0") || Buffer.byteLength(argument) > 64 * 1024)
		) {
			throw new TypeError("Claude Code SDK spawn request does not match its trusted target");
		}
		if (
			this.#target.modulePath !== this.#target.executablePath &&
			!options.args.some((argument) => {
				try {
					return realpathSync(argument) === realpathSync(this.#target.modulePath);
				} catch {
					return false;
				}
			})
		) throw new TypeError("Claude Code SDK spawn request omitted its trusted module");
		const environmentEntries = Object.entries(options.env);
		if (
			environmentEntries.length > MAX_ENVIRONMENT_KEYS ||
			environmentEntries.some(([key, value]) =>
				SENSITIVE_ENVIRONMENT_KEY.test(key) ||
				value === undefined ||
				key.includes("=") ||
				key.includes("\0") ||
				value.includes("\0") ||
				Buffer.byteLength(value) > 64 * 1024
			)
		) throw new TypeError("Claude Code SDK spawn environment is not a safe bounded projection");
		return new ContainedClaudeProcess(channel, {
			command,
			args: Object.freeze([...options.args]),
			cwd,
			env: Object.freeze(Object.fromEntries(environmentEntries) as Record<string, string>),
		}, options.signal);
	}
}
