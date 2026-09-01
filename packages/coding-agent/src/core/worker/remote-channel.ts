import { readFile } from "node:fs/promises";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";
import { validateEndpointSecurity } from "@aos-agent/agent-core";
import { Agent as UndiciAgent, type MessageEvent as UndiciMessageEvent, WebSocket } from "undici";
import type { RpcClientTlsOptions } from "../../modes/rpc/rpc-client.ts";
import {
	type WebsocketRpcAddress,
	validateRpcTransportAddress,
} from "../../modes/rpc/rpc-transport-address.ts";

const DEFAULT_REMOTE_WORKER_CONNECT_TIMEOUT_MS = 10_000;
const MAX_REMOTE_WORKER_CONNECT_TIMEOUT_MS = 2_147_483_647;

export interface WorkerRemoteEndpointConfig {
	/** Shared RPC transport address, including bearer or mTLS authentication. */
	readonly address: WebsocketRpcAddress;
	/** Maximum time to establish the WS/WSS channel. */
	readonly connectTimeoutMs?: number;
	/** Client trust and optional mTLS certificate paths. */
	readonly tls?: RpcClientTlsOptions;
}

interface ResolvedWorkerRemoteEndpointConfig {
	readonly address: WebsocketRpcAddress;
	readonly connectTimeoutMs: number;
	readonly tls?: RpcClientTlsOptions;
}

export interface RemoteWorkerChannelCallbacks {
	readonly onData: (chunk: string) => void;
	readonly onEnd: () => void;
	readonly onError: (error: Error) => void;
}

export class RemoteWorkerChannelError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RemoteWorkerChannelError";
	}
}

export function resolveWorkerRemoteEndpoint(
	config: WorkerRemoteEndpointConfig,
): ResolvedWorkerRemoteEndpointConfig {
	const address = validateRpcTransportAddress(config.address);
	if (address.transport !== "websocket") {
		throw new RemoteWorkerChannelError("Remote Worker endpoint must use WebSocket transport");
	}
	const endpoint = validateEndpointSecurity({
		kind: "websocket",
		host: address.host,
		port: address.port,
		...(address.auth === undefined ? {} : { auth: { scheme: address.auth.scheme } }),
		...(address.tls === undefined ? {} : { tls: address.tls }),
		allowRemote: address.allowRemote ?? false,
	});
	if (!endpoint.ok) throw new RemoteWorkerChannelError("Remote Worker endpoint security is invalid");
	const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_REMOTE_WORKER_CONNECT_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(connectTimeoutMs) ||
		connectTimeoutMs <= 0 ||
		connectTimeoutMs > MAX_REMOTE_WORKER_CONNECT_TIMEOUT_MS
	) {
		throw new RemoteWorkerChannelError("Remote Worker connect timeout is invalid");
	}
	if (config.tls !== undefined && address.tls?.enabled !== true) {
		throw new RemoteWorkerChannelError("Remote Worker TLS client options require a WSS endpoint");
	}
	if ((config.tls?.certPath === undefined) !== (config.tls?.keyPath === undefined)) {
		throw new RemoteWorkerChannelError("Remote Worker TLS certificate and key must be configured together");
	}
	if (
		address.auth?.scheme === "mtls" &&
		(config.tls?.certPath === undefined || config.tls.keyPath === undefined)
	) {
		throw new RemoteWorkerChannelError("Remote Worker mTLS endpoint requires a client certificate and key");
	}
	return Object.freeze({
		address: Object.freeze({
			...address,
			...(address.auth === undefined ? {} : { auth: Object.freeze({ ...address.auth }) }),
			...(address.tls === undefined ? {} : { tls: Object.freeze({ ...address.tls }) }),
		}),
		connectTimeoutMs,
		...(config.tls === undefined ? {} : { tls: Object.freeze({ ...config.tls }) }),
	});
}

export class RemoteWorkerChannel {
	private readonly config: ResolvedWorkerRemoteEndpointConfig;
	private readonly callbacks: RemoteWorkerChannelCallbacks;
	private websocket?: WebSocket;
	private dispatcher?: UndiciAgent;
	private connected = false;
	private closedValue = false;
	private endReported = false;

	constructor(config: WorkerRemoteEndpointConfig, callbacks: RemoteWorkerChannelCallbacks) {
		this.config = resolveWorkerRemoteEndpoint(config);
		this.callbacks = callbacks;
	}

	get closed(): boolean {
		return this.closedValue || this.websocket?.readyState === WebSocket.CLOSED;
	}

	get bufferedAmount(): number {
		return this.websocket?.bufferedAmount ?? 0;
	}

	async connect(): Promise<void> {
		if (this.websocket !== undefined || this.closedValue) {
			throw new RemoteWorkerChannelError("Remote Worker channel cannot be reused");
		}
		let tlsOptions: TlsConnectionOptions | undefined;
		try {
			tlsOptions = await loadClientTlsOptions(this.config.tls);
		} catch (error: unknown) {
			throw new RemoteWorkerChannelError("Remote Worker TLS credentials could not be loaded", error);
		}
		const dispatcher = tlsOptions === undefined ? undefined : new UndiciAgent({ connect: tlsOptions });
		this.dispatcher = dispatcher;
		const address = this.config.address;
		let websocket: WebSocket;
		try {
			websocket = new WebSocket(
				`${address.tls?.enabled === true ? "wss" : "ws"}://${address.host}:${address.port}${address.path}`,
				{
					...(address.auth?.scheme === "bearer"
						? { headers: { Authorization: `Bearer ${address.auth.bearerToken}` } }
						: {}),
					...(dispatcher === undefined ? {} : { dispatcher }),
				},
			);
		} catch (error: unknown) {
			await this.closeDispatcher();
			throw new RemoteWorkerChannelError("Remote Worker connection failed", error);
		}
		this.websocket = websocket;
		websocket.addEventListener("message", this.onMessage);
		websocket.addEventListener("error", this.onError);
		websocket.addEventListener("close", this.onClose);

		try {
			await this.waitForOpen(websocket);
			this.connected = true;
		} catch (error: unknown) {
			this.detachWebsocket(websocket);
			this.websocket = undefined;
			this.closedValue = true;
			if (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN) {
				websocket.close();
			}
			await this.closeDispatcher();
			throw error instanceof RemoteWorkerChannelError
				? error
				: new RemoteWorkerChannelError("Remote Worker connection failed", error);
		}
	}

	write(line: string, maxPendingBytes: number): Promise<void> {
		const websocket = this.websocket;
		if (
			websocket === undefined ||
			this.closedValue ||
			websocket.readyState !== WebSocket.OPEN
		) {
			return Promise.reject(new RemoteWorkerChannelError("Remote Worker connection is closed"));
		}
		const bytes = Buffer.byteLength(line, "utf8");
		if (websocket.bufferedAmount + bytes > maxPendingBytes) {
			return Promise.reject(new RemoteWorkerChannelError("Remote Worker pending-write capacity was exceeded"));
		}
		try {
			websocket.send(line);
			return Promise.resolve();
		} catch (error: unknown) {
			return Promise.reject(new RemoteWorkerChannelError("Remote Worker write failed", error));
		}
	}

	close(): void {
		const websocket = this.websocket;
		if (websocket === undefined || this.closedValue) return;
		if (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN) {
			websocket.close();
		}
	}

	detach(): void {
		const websocket = this.websocket;
		if (websocket !== undefined) this.detachWebsocket(websocket);
		this.websocket = undefined;
		this.closedValue = true;
		void this.closeDispatcher();
	}

	private readonly onMessage = (event: UndiciMessageEvent): void => {
		if (!this.connected || this.closedValue) return;
		if (typeof event.data !== "string") {
			this.callbacks.onError(new RemoteWorkerChannelError("Remote Worker returned a non-text frame"));
			this.close();
			return;
		}
		this.callbacks.onData(event.data);
	};

	private readonly onError = (): void => {
		if (!this.connected || this.closedValue) return;
		this.callbacks.onError(new RemoteWorkerChannelError("Remote Worker connection failed"));
	};

	private readonly onClose = (): void => {
		if (this.closedValue) return;
		this.closedValue = true;
		this.connected = false;
		if (!this.endReported) {
			this.endReported = true;
			this.callbacks.onEnd();
		}
		void this.closeDispatcher();
	};

	private waitForOpen(websocket: WebSocket): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				websocket.removeEventListener("open", onOpen);
				websocket.removeEventListener("error", onConnectError);
				websocket.removeEventListener("close", onConnectClose);
				if (error === undefined) resolve();
				else reject(error);
			};
			const onOpen = (): void => finish();
			const onConnectError = (): void =>
				finish(new RemoteWorkerChannelError("Remote Worker connection failed"));
			const onConnectClose = (): void =>
				finish(new RemoteWorkerChannelError("Remote Worker connection closed during startup"));
			const timeout = setTimeout(
				() => finish(new RemoteWorkerChannelError("Remote Worker connection timed out")),
				this.config.connectTimeoutMs,
			);
			timeout.unref();
			websocket.addEventListener("open", onOpen);
			websocket.addEventListener("error", onConnectError);
			websocket.addEventListener("close", onConnectClose);
		});
	}

	private detachWebsocket(websocket: WebSocket): void {
		websocket.removeEventListener("message", this.onMessage);
		websocket.removeEventListener("error", this.onError);
		websocket.removeEventListener("close", this.onClose);
	}

	private async closeDispatcher(): Promise<void> {
		const dispatcher = this.dispatcher;
		this.dispatcher = undefined;
		if (dispatcher !== undefined) await dispatcher.close().catch(() => undefined);
	}
}

async function loadClientTlsOptions(
	tls: RpcClientTlsOptions | undefined,
): Promise<TlsConnectionOptions | undefined> {
	if (tls === undefined) return undefined;
	const [ca, cert, key] = await Promise.all([
		tls.caPath === undefined ? Promise.resolve(undefined) : readFile(tls.caPath),
		tls.certPath === undefined ? Promise.resolve(undefined) : readFile(tls.certPath),
		tls.keyPath === undefined ? Promise.resolve(undefined) : readFile(tls.keyPath),
	]);
	return {
		...(ca === undefined ? {} : { ca }),
		...(cert === undefined ? {} : { cert }),
		...(key === undefined ? {} : { key }),
		minVersion: tls.minVersion === "1.3" ? "TLSv1.3" : "TLSv1.2",
	};
}
