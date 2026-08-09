import { AosServer } from "../server.ts";
import type { AosServerOptions, AosServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends AosServerOptions {
	service?: AosServerService;
}

export interface TestServer {
	server: AosServer;
	service: AosServerService;
}

/** Create an unstarted AosServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new AosServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
