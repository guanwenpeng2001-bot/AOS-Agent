/**
 * The only network addresses accepted by the loopback RPC transports.
 *
 * This module is shared by CLI parsing, RpcClient option normalization, and
 * listeners so each boundary applies the same contract.
 */
export const RPC_TRANSPORT_LOOPBACK_HOST = "127.0.0.1" as const;
export const RPC_TRANSPORT_PORT_MIN = 1;
export const RPC_TRANSPORT_PORT_MAX = 65_535;
export const RPC_WEBSOCKET_DEFAULT_PATH = "/rpc" as const;

export interface TcpRpcAddress {
	readonly transport: "tcp";
	readonly host: typeof RPC_TRANSPORT_LOOPBACK_HOST;
	readonly port: number;
}

export interface WebsocketRpcAddress {
	readonly transport: "websocket";
	readonly host: typeof RPC_TRANSPORT_LOOPBACK_HOST;
	readonly port: number;
	readonly path: typeof RPC_WEBSOCKET_DEFAULT_PATH;
}

export type RpcTransportAddress = TcpRpcAddress | WebsocketRpcAddress;

export type RpcTransportAddressErrorCode = "rpc_transport_address_invalid" | "rpc_transport_not_loopback";

/** A safe-to-display error produced while validating a TCP address. */
export class RpcTransportAddressError extends Error {
	readonly code: RpcTransportAddressErrorCode;

	constructor(code: RpcTransportAddressErrorCode, message: string) {
		super(message);
		this.name = "RpcTransportAddressError";
		this.code = code;
	}
}

export type RpcTransportAddressParseResult =
	| { readonly address: RpcTransportAddress }
	| { readonly error: RpcTransportAddressError };

const TCP_SCHEME_PREFIX = "tcp://";
const WEBSOCKET_SCHEME_PREFIX = "ws://";

const INVALID_TCP_ADDRESS_MESSAGE =
	"TCP transport address must be tcp://127.0.0.1:<port> without credentials, path, query, or fragment.";
const INVALID_WEBSOCKET_ADDRESS_MESSAGE =
	"WebSocket transport address must be ws://127.0.0.1:<port> with the optional /rpc path and without credentials, query, or fragment.";
const TCP_NOT_LOOPBACK_MESSAGE = "TCP transport address must use the IPv4 loopback host 127.0.0.1.";
const WEBSOCKET_NOT_LOOPBACK_MESSAGE =
	"WebSocket transport address must use the IPv4 loopback host 127.0.0.1.";

function invalidAddress(message: string): RpcTransportAddressParseResult {
	return {
		error: new RpcTransportAddressError("rpc_transport_address_invalid", message),
	};
}

function notLoopback(message: string): RpcTransportAddressParseResult {
	return {
		error: new RpcTransportAddressError("rpc_transport_not_loopback", message),
	};
}

/**
 * Parse the supported loopback Automation Host network address forms.
 *
 * URL parsing validates the authority, while the raw value is checked to
 * prevent URL normalization from accepting malformed ports or components.
 */
export function parseRpcTransportAddress(value: string): RpcTransportAddressParseResult {
	if (typeof value !== "string" || value.trim() !== value) {
		return invalidAddress(INVALID_TCP_ADDRESS_MESSAGE);
	}
	const transport =
		value.startsWith(TCP_SCHEME_PREFIX)
			? "tcp"
			: value.startsWith(WEBSOCKET_SCHEME_PREFIX)
				? "websocket"
				: undefined;
	if (transport === undefined) return invalidAddress(INVALID_TCP_ADDRESS_MESSAGE);
	const invalidMessage =
		transport === "tcp" ? INVALID_TCP_ADDRESS_MESSAGE : INVALID_WEBSOCKET_ADDRESS_MESSAGE;
	const notLoopbackMessage =
		transport === "tcp" ? TCP_NOT_LOOPBACK_MESSAGE : WEBSOCKET_NOT_LOOPBACK_MESSAGE;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalidAddress(invalidMessage);
	}

	if (url.protocol !== (transport === "tcp" ? "tcp:" : "ws:")) return invalidAddress(invalidMessage);
	const pathStart = value.indexOf("/", value.indexOf("://") + 3);
	const websocketPathInvalid =
		transport === "websocket" &&
		(pathStart === -1 ? url.pathname !== "/" : url.pathname !== RPC_WEBSOCKET_DEFAULT_PATH);

	// URL can normalize a bare '?' or '#', so inspect the raw value as well.
	if (
		url.username !== "" ||
		url.password !== "" ||
		(transport === "tcp" ? url.pathname !== "" : websocketPathInvalid) ||
		url.search !== "" ||
		url.hash !== "" ||
		value.includes("?") ||
		value.includes("#")
	) {
		return invalidAddress(invalidMessage);
	}

	// Bracketed hosts and hostnames containing ':' are IPv6 forms, which are
	// deliberately outside the RPC transport contract even when they name ::1.
	if (url.hostname.length === 0 || url.hostname.startsWith("[") || url.hostname.includes(":")) {
		return invalidAddress(invalidMessage);
	}
	if (url.hostname !== RPC_TRANSPORT_LOOPBACK_HOST) return notLoopback(notLoopbackMessage);

	const authorityEnd = pathStart;
	const authority = authorityEnd === -1 ? value : value.slice(0, authorityEnd);
	const rawPort = authority.slice(authority.lastIndexOf(":") + 1);
	const canonicalHref =
		transport === "websocket" && url.pathname === "/" && !value.endsWith("/") ? `${value}/` : value;
	if (url.port === "" || !/^\d+$/.test(rawPort) || url.href !== canonicalHref) {
		return invalidAddress(invalidMessage);
	}

	const port = Number(rawPort);
	if (!Number.isSafeInteger(port) || port < RPC_TRANSPORT_PORT_MIN || port > RPC_TRANSPORT_PORT_MAX) {
		return invalidAddress(invalidMessage);
	}

	return {
		address:
			transport === "tcp"
				? { transport, host: RPC_TRANSPORT_LOOPBACK_HOST, port }
				: { transport, host: RPC_TRANSPORT_LOOPBACK_HOST, port, path: RPC_WEBSOCKET_DEFAULT_PATH },
	};
}

/** Validate a structured network address used by the client or listener. */
export function validateRpcTransportAddress(value: unknown): RpcTransportAddress {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_TCP_ADDRESS_MESSAGE);
	}

	const candidate = value as { transport?: unknown; host?: unknown; port?: unknown; path?: unknown };
	if (candidate.transport !== "tcp" && candidate.transport !== "websocket") {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_TCP_ADDRESS_MESSAGE);
	}
	const invalidMessage =
		candidate.transport === "tcp" ? INVALID_TCP_ADDRESS_MESSAGE : INVALID_WEBSOCKET_ADDRESS_MESSAGE;
	const notLoopbackMessage =
		candidate.transport === "tcp" ? TCP_NOT_LOOPBACK_MESSAGE : WEBSOCKET_NOT_LOOPBACK_MESSAGE;
	if (candidate.host !== RPC_TRANSPORT_LOOPBACK_HOST) {
		if (typeof candidate.host === "string" && candidate.host.length > 0) {
			throw new RpcTransportAddressError("rpc_transport_not_loopback", notLoopbackMessage);
		}
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	if (
		typeof candidate.port !== "number" ||
		!Number.isSafeInteger(candidate.port) ||
		candidate.port < RPC_TRANSPORT_PORT_MIN ||
		candidate.port > RPC_TRANSPORT_PORT_MAX
	) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	if (
		(candidate.transport === "tcp" && candidate.path !== undefined) ||
		(candidate.transport === "websocket" &&
			candidate.path !== undefined &&
			candidate.path !== RPC_WEBSOCKET_DEFAULT_PATH)
	) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}

	return candidate.transport === "tcp"
		? { transport: "tcp", host: RPC_TRANSPORT_LOOPBACK_HOST, port: candidate.port }
		: {
				transport: "websocket",
				host: RPC_TRANSPORT_LOOPBACK_HOST,
				port: candidate.port,
				path: RPC_WEBSOCKET_DEFAULT_PATH,
			};
}

export function isRpcTransportAddressError(value: unknown): value is RpcTransportAddressError {
	return value instanceof RpcTransportAddressError;
}

export function formatRpcTransportAddress(address: RpcTransportAddress): string {
	return address.transport === "tcp"
		? `tcp://${address.host}:${address.port}`
		: `ws://${address.host}:${address.port}${address.path}`;
}
