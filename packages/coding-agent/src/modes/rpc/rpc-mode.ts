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
import {
	ShutdownCoordinator,
	type ShutdownFailure,
	type ShutdownRequest,
} from "../../core/shutdown-coordinator.ts";
import { formatRpcTransportAddress, type RpcTransportAddress } from "./rpc-transport-address.ts";
import { createRpcTransport, RpcTransportError } from "./rpc-transport.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { createRpcHostController, type RpcHostOutputRecord } from "./rpc-host.ts";
import type { RpcCommand, RpcExtensionUIResponse } from "./rpc-types.ts";

export interface RpcModeOptions {
	/** Listen for JSONL RPC commands over loopback TCP instead of process stdio. */
	readonly listen?: RpcTransportAddress;
}

type TcpRpcCommand = RpcCommand | RpcExtensionUIResponse;

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

	let detachJsonl = (): void => {};
	let shutdownRequest: ShutdownRequest | undefined;
	const onInputEnd = (): void => requestProcessShutdown();
	const shutdownCoordinator = new ShutdownCoordinator({
		closeAdmission: (request) => {
			shutdownRequest = request;
			runtimeHost.closeAdmissionForShutdown();
			if (request.signal !== undefined) killTrackedDetachedChildren();
			detachJsonl();
			process.stdin.off("end", onInputEnd);
			process.stdin.pause();
		},
		handoffRecovery: () => controller.isShuttingDown ? undefined : runtimeHost.handoffShutdownRecovery(),
		resourceGroups: [[{ name: "rpc_controller", cleanup: () => controller.shutdown() }]],
		finalize: () => shutdownRequest?.signal === "SIGTERM" ? undefined : flushRawStdout(),
		onFailure: reportShutdownFailure,
	});
	shutdownCoordinator.installSignalHandlers();

	const shutdown = (exitCode = 0) => shutdownCoordinator.requestShutdown(exitCode);
	requestProcessShutdown = (): void => {
		void shutdown();
	};

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

	process.stdin.on("end", onInputEnd);

	detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
		void handleInputLine(line);
	});
	if (shutdownCoordinator.state !== "accepting") {
		detachJsonl();
		process.stdin.off("end", onInputEnd);
		process.stdin.pause();
	}

	// Keep process alive forever. The input adapter and signal handlers own the
	// eventual process exit after the controller has disposed its runtime.
	return new Promise<never>(() => {});
}

/** Run the RPC host over one-at-a-time loopback TCP JSONL connections. */
async function runTcpRpcMode(runtimeHost: AgentSessionRuntime, address: RpcTransportAddress): Promise<never> {
	let requestProcessShutdown = (): void => {};
	let detachPromise = Promise.resolve();
	let detachConnection = (): void => {};

	const controller = createRpcHostController(runtimeHost, {
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
			await controller.dispatch(command);
		},
		onConnection: (connection) => {
			void detachPromise.then(() => {
				if (!connection.closed) detachConnection = controller.attach(connection);
			});
			reportDiagnostic(`connection ${connection.id} accepted`);
		},
		onConnectionClose: (connection) => {
			const detach = detachConnection;
			detachConnection = () => {};
			detach();
			reportDiagnostic(`connection ${connection.id} closed`);
			detachPromise = controller.detachTransport().catch((error: unknown) => {
				reportDiagnostic(`connection ${connection.id} cleanup failed: ${toError(error).message}`);
			});
		},
		onError: (error) => {
			reportDiagnostic(`${error.code}: ${error.message}`);
		},
	});
	let transportClosePromise: Promise<void> | undefined;
	const closeTransport = (): Promise<void> => {
		transportClosePromise ??= transport.close();
		return transportClosePromise;
	};

	const shutdownCoordinator = new ShutdownCoordinator({
		closeAdmission: (request) => {
			runtimeHost.closeAdmissionForShutdown();
			void closeTransport().catch(() => {});
			if (request.signal !== undefined) killTrackedDetachedChildren();
		},
		handoffRecovery: () => controller.isShuttingDown ? undefined : runtimeHost.handoffShutdownRecovery(),
		resourceGroups: [
			[{ name: "rpc_transport", cleanup: closeTransport }],
			[{
				name: "rpc_connection",
				cleanup: async () => {
					detachConnection();
					await controller.detachTransport();
				},
			}],
			[{ name: "rpc_controller", cleanup: () => controller.shutdown() }],
		],
		onFailure: reportShutdownFailure,
	});
	shutdownCoordinator.installSignalHandlers();

	const shutdown = (exitCode = 0) => shutdownCoordinator.requestShutdown(exitCode);
	requestProcessShutdown = (): void => {
		void shutdown();
	};

	try {
		await transport.start();
	} catch (error: unknown) {
		const diagnostic =
			error instanceof RpcTransportError ? `${error.code}: ${error.message}` : toError(error).message;
		console.error(`Error: Failed to bind RPC TCP listener at ${formatRpcTransportAddress(address)}: ${diagnostic}`);
		await shutdown(1);
		return new Promise<never>(() => {});
	}

	const boundAddress = transport.address;
	if (boundAddress === undefined) {
		reportDiagnostic("listener started without a bound TCP address");
		await shutdown(1);
		return new Promise<never>(() => {});
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

function reportShutdownFailure(failure: ShutdownFailure): void {
	console.error(`[shutdown] ${failure.resource} ${failure.reason.replaceAll("_", " ")}`);
}
