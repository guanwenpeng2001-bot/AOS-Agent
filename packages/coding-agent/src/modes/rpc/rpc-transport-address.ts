/**
 * The only TCP address accepted by the loopback RPC transport.
 *
 * This module is shared by CLI parsing, RpcClient option normalization, and
 * the TCP listener so each boundary applies the same contract.
 */
export const RPC_TRANSPORT_LOOPBACK_HOST = "127.0.0.1" as const;
export const RPC_TRANSPORT_PORT_MIN = 1;
export const RPC_TRANSPORT_PORT_MAX = 65_535;

export interface TcpRpcAddress {
	readonly transport: "tcp";
	readonly host: typeof RPC_TRANSPORT_LOOPBACK_HOST;
	readonly port: number;
}

export type RpcTransportAddress = TcpRpcAddress;

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
	| { readonly address: TcpRpcAddress }
	| { readonly error: RpcTransportAddressError };

const TCP_SCHEME_PREFIX = "tcp://";

const INVALID_ADDRESS_MESSAGE =
	"TCP transport address must be tcp://127.0.0.1:<port> without credentials, path, query, or fragment.";
const NOT_LOOPBACK_MESSAGE = "TCP transport address must use the IPv4 loopback host 127.0.0.1.";

function invalidAddress(): RpcTransportAddressParseResult {
	return {
		error: new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_ADDRESS_MESSAGE),
	};
}

function notLoopback(): RpcTransportAddressParseResult {
	return {
		error: new RpcTransportAddressError("rpc_transport_not_loopback", NOT_LOOPBACK_MESSAGE),
	};
}

/**
 * Parse the only supported Automation Host TCP address form.
 *
 * URL parsing validates the authority, while the raw value is checked to
 * prevent URL normalization from accepting malformed ports or components.
 */
export function parseRpcTransportAddress(value: string): RpcTransportAddressParseResult {
	if (typeof value !== "string" || value.trim() !== value || !value.startsWith(TCP_SCHEME_PREFIX)) {
		return invalidAddress();
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalidAddress();
	}

	if (url.protocol !== "tcp:") return invalidAddress();

	// URL can normalize a bare '?' or '#', so inspect the raw value as well.
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		value.includes("?") ||
		value.includes("#")
	) {
		return invalidAddress();
	}

	// Bracketed hosts and hostnames containing ':' are IPv6 forms, which are
	// deliberately outside the v1 contract even when they name ::1.
	if (url.hostname.length === 0 || url.hostname.startsWith("[") || url.hostname.includes(":")) return invalidAddress();
	if (url.hostname !== RPC_TRANSPORT_LOOPBACK_HOST) return notLoopback();

	const rawPort = value.slice(value.lastIndexOf(":") + 1);
	if (url.port === "" || !/^\d+$/.test(rawPort) || url.href !== value) return invalidAddress();

	const port = Number(rawPort);
	if (!Number.isSafeInteger(port) || port < RPC_TRANSPORT_PORT_MIN || port > RPC_TRANSPORT_PORT_MAX) {
		return invalidAddress();
	}

	return {
		address: {
			transport: "tcp",
			host: RPC_TRANSPORT_LOOPBACK_HOST,
			port,
		},
	};
}

/** Validate a structured TCP address used by the client or listener. */
export function validateRpcTransportAddress(value: unknown): TcpRpcAddress {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_ADDRESS_MESSAGE);
	}

	const candidate = value as { transport?: unknown; host?: unknown; port?: unknown };
	if (candidate.transport !== "tcp") {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_ADDRESS_MESSAGE);
	}
	if (candidate.host !== RPC_TRANSPORT_LOOPBACK_HOST) {
		if (typeof candidate.host === "string" && candidate.host.length > 0) {
			throw new RpcTransportAddressError("rpc_transport_not_loopback", NOT_LOOPBACK_MESSAGE);
		}
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_ADDRESS_MESSAGE);
	}
	if (
		typeof candidate.port !== "number" ||
		!Number.isSafeInteger(candidate.port) ||
		candidate.port < RPC_TRANSPORT_PORT_MIN ||
		candidate.port > RPC_TRANSPORT_PORT_MAX
	) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_ADDRESS_MESSAGE);
	}

	return {
		transport: "tcp",
		host: RPC_TRANSPORT_LOOPBACK_HOST,
		port: candidate.port,
	};
}

export function isRpcTransportAddressError(value: unknown): value is RpcTransportAddressError {
	return value instanceof RpcTransportAddressError;
}

export function formatRpcTransportAddress(address: TcpRpcAddress): string {
	return `tcp://${address.host}:${address.port}`;
}
