import { FoundationError } from "@aos-agent/agent-core";
import type {
	ExternalConnectorProcessChannel,
	ExternalConnectorProcessController,
} from "../supervisor.ts";
import {
	PRIVATE_CODEX_APP_SERVER_IDENTITY,
	type PrivateCodexAppServerTransport,
	type PrivateCodexAppServerTransportFactory,
} from "./codex.ts";
import type {
	PrivateAcpStableV1Transport,
	PrivateAcpStableV1TransportFactory,
} from "./acp.ts";

function unavailable(driver: "codex" | "acp"): FoundationError {
	return new FoundationError(
		"external_connector_unavailable",
		`The configured ${driver} process channel is unavailable. Verify the pinned executable and follow the vendor installation guide.`,
	);
}

function channelFor(
	controller: ExternalConnectorProcessController,
	driver: "codex" | "acp",
	reference: { readonly supervisorRef: string; readonly operationNonce: string },
): ExternalConnectorProcessChannel {
	const channel = controller.channelFor?.(reference);
	if (channel === undefined) throw unavailable(driver);
	return channel;
}

function readableBytes(channel: ExternalConnectorProcessChannel): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const line = await channel.readLine();
			if (line === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(`${line}\n`));
		},
	});
}

function writableBytes(channel: ExternalConnectorProcessChannel): WritableStream<Uint8Array> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffered = "";
	return new WritableStream<Uint8Array>({
		write(chunk) {
			buffered += decoder.decode(chunk, { stream: true });
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				channel.writeLine(line);
			}
		},
		close() {
			buffered += decoder.decode();
			if (buffered.length !== 0) throw new Error("External Connector process transport ended with a partial frame");
		},
		abort() {
			buffered = "";
		},
	});
}

function transport(channel: ExternalConnectorProcessChannel): PrivateAcpStableV1Transport {
	return Object.freeze({
		input: readableBytes(channel),
		output: writableBytes(channel),
		close: () => undefined,
	});
}

export function createPrivateCodexProcessTransportFactory(
	controller: ExternalConnectorProcessController,
): PrivateCodexAppServerTransportFactory {
	return async (request): Promise<PrivateCodexAppServerTransport> => ({
		...transport(channelFor(controller, "codex", request)),
		identity: PRIVATE_CODEX_APP_SERVER_IDENTITY,
	});
}

export function createPrivateAcpProcessTransportFactory(
	controller: ExternalConnectorProcessController,
): PrivateAcpStableV1TransportFactory {
	return async (request) => transport(channelFor(controller, "acp", request));
}
