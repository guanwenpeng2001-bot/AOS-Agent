/**
 * RPC adapters for the legacy stdio mode and the loopback TCP listener.
 */

import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { redactErrorText } from "../../core/run-lifecycle.ts";
import { formatRpcTransportAddress, type RpcTransportAddress } from "./rpc-transport-address.ts";
import { createRpcTransport, RpcTransportError, type RpcTransportConnection } from "./rpc-transport.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { createRpcHostController, type RpcHostOutputRecord } from "./rpc-host.ts";
import type { RpcCommand, RpcExtensionUIResponse } from "./rpc-types.ts";

export interface RpcModeOptions {
	/** Listen for JSONL RPC commands over loopback TCP instead of process stdio. */
	readonly listen?: RpcTransportAddress;
}

type TcpRpcCommand = RpcCommand | RpcExtensionUIResponse;

/**
 * Bridges the controller's synchronous output sink to the currently attached
 * TCP connection. Records produced after a disconnect are dropped; the host
 * remains alive and can be attached to a later connection.
 */
class TcpRpcOutputSink {
	private connection?: RpcTransportConnection<TcpRpcCommand, RpcHostOutputRecord>;
	private readonly pendingWrites = new Set<Promise<void>>();

	attach(connection: RpcTransportConnection<TcpRpcCommand, RpcHostOutputRecord>): void {
		this.connection = connection;
	}

	async attachWhenReady(
		connection: RpcTransportConnection<TcpRpcCommand, RpcHostOutputRecord>,
		ready: Promise<void>,
	): Promise<void> {
		await ready;
		if (!connection.closed) this.attach(connection);
	}

	detach(connection: RpcTransportConnection<TcpRpcCommand, RpcHostOutputRecord>): void {
		if (this.connection === connection) this.connection = undefined;
	}

	publish(record: RpcHostOutputRecord): void {
		const connection = this.connection;
		if (connection === undefined || connection.closed) return;
		const pending = connection.send(record).catch(() => {});
		this.pendingWrites.add(pending);
		void pending.finally(() => this.pendingWrites.delete(pending));
	}

	async waitForBackpressure(): Promise<void> {
		await Promise.all([...this.pendingWrites]);
	}
}

/** Run the selected RPC transport. Stdio remains the default for compatibility. */
export async function runRpcMode(runtimeHost: AgentSessionRuntime, options?: RpcModeOptions): Promise<never> {
	takeOverStdout();
	if (options?.listen === undefined) return runStdioRpcMode(runtimeHost);
	return runTcpRpcMode(runtimeHost, options.listen);
}

/** Run the legacy JSONL RPC mode over process stdio. */
async function runStdioRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	let requestProcessShutdown = (): void => {};

	const controller = createRpcHostController(runtimeHost, {
		output: {
			publish: (record: RpcHostOutputRecord) => {
				writeRawStdout(serializeJsonLine(record));
			},
			waitForBackpressure: waitForRawStdoutBackpressure,
		},
		onShutdown: () => requestProcessShutdown(),
	});
	await controller.start();

	let shuttingDown = false;
	let detachJsonl = (): void => {};
	const signalCleanupHandlers: Array<() => void> = [];

	const shutdown = async (exitCode = 0, signal?: NodeJS.Signals): Promise<never> => {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) cleanup();
		if (signal !== undefined) killTrackedDetachedChildren();
		await controller.shutdown();
		detachJsonl();
		process.stdin.off("end", onInputEnd);
		process.stdin.pause();
		if (signal !== "SIGTERM") await flushRawStdout();
		process.exit(exitCode);
	};
	requestProcessShutdown = (): void => {
		if (!shuttingDown) void shutdown();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = (): void => {
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};
	registerSignalHandlers();

	const handleInputLine = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			writeRawStdout(
				serializeJsonLine({
					id: undefined,
					type: "response",
					command: "parse",
					success: false,
					error: redactErrorText(
						`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					),
				}),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			controller.handleExtensionUIResponse(parsed as RpcExtensionUIResponse);
			return;
		}

		await controller.handleCommand(parsed as RpcCommand);
		if (controller.isShuttingDown) {
			await shutdown();
		}
	};

	const onInputEnd = (): void => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
		void handleInputLine(line);
	});

	// Keep process alive forever. The input adapter and signal handlers own the
	// eventual process exit after the controller has disposed its runtime.
	return new Promise<never>(() => {});
}

/** Run the RPC host over one-at-a-time loopback TCP JSONL connections. */
async function runTcpRpcMode(runtimeHost: AgentSessionRuntime, address: RpcTransportAddress): Promise<never> {
	const outputSink = new TcpRpcOutputSink();
	let requestProcessShutdown = (): void => {};
	let detachPromise = Promise.resolve();

	const controller = createRpcHostController(runtimeHost, {
		output: outputSink,
		onShutdown: () => requestProcessShutdown(),
	});
	await controller.start();

	const reportDiagnostic = (message: string): void => {
		console.error(`[rpc] ${message}`);
	};

	const transport = createRpcTransport<TcpRpcCommand, RpcHostOutputRecord>({
		address,
		parseCommand: parseTcpRpcCommand,
		dispatch: async (command) => {
			await detachPromise;
			if (command.type === "extension_ui_response") {
				controller.handleExtensionUIResponse(command);
				return;
			}
			await controller.handleCommand(command);
		},
		onConnection: (connection) => {
			void outputSink.attachWhenReady(connection, detachPromise);
			reportDiagnostic(`connection ${connection.id} accepted`);
		},
		onConnectionClose: (connection) => {
			outputSink.detach(connection);
			reportDiagnostic(`connection ${connection.id} closed`);
			detachPromise = controller.detachTransport().catch((error: unknown) => {
				reportDiagnostic(`connection ${connection.id} cleanup failed: ${toError(error).message}`);
			});
		},
		onError: (error) => {
			reportDiagnostic(`${error.code}: ${error.message}`);
		},
	});

	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const shutdown = async (exitCode = 0, signal?: NodeJS.Signals): Promise<never> => {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) cleanup();
		if (signal !== undefined) killTrackedDetachedChildren();
		await transport.close();
		await controller.detachTransport();
		await controller.shutdown();
		process.exit(exitCode);
	};
	requestProcessShutdown = (): void => {
		if (!shuttingDown) void shutdown();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = (): void => {
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};
	registerSignalHandlers();

	try {
		await transport.start();
	} catch (error: unknown) {
		const diagnostic =
			error instanceof RpcTransportError ? `${error.code}: ${error.message}` : toError(error).message;
		console.error(`Error: Failed to bind RPC TCP listener at ${formatRpcTransportAddress(address)}: ${diagnostic}`);
		await controller.shutdown();
		process.exit(1);
	}

	const boundAddress = transport.address;
	if (boundAddress === undefined) {
		reportDiagnostic("listener started without a bound TCP address");
		await controller.shutdown();
		process.exit(1);
	}
	console.error(`RPC TCP listening on ${formatRpcTransportAddress(boundAddress)}`);

	// The listener, not stdin, owns process liveness in TCP mode.
	return new Promise<never>(() => {});
}

function parseTcpRpcCommand(value: unknown): TcpRpcCommand {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("RPC command must be a JSON object");
	}
	const type = (value as { type?: unknown }).type;
	if (typeof type !== "string" || type.length === 0) {
		throw new TypeError("RPC command must include a string type");
	}
	return value as TcpRpcCommand;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
