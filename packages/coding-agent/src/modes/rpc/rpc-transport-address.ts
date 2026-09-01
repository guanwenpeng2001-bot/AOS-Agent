/** Shared RPC network address and transport-security configuration. */
export const RPC_TRANSPORT_LOOPBACK_HOST = "127.0.0.1" as const;
export const RPC_TRANSPORT_PORT_MIN = 1;
export const RPC_TRANSPORT_PORT_MAX = 65_535;
export const RPC_WEBSOCKET_DEFAULT_PATH = "/rpc" as const;

export interface RpcTransportAuthConfig {
	readonly scheme: "none" | "bearer" | "mtls";
	/** Expected bearer material. It is never included in formatted addresses or errors. */
	readonly bearerToken?: string;
}


export interface RpcTransportTlsConfig {
	readonly enabled: boolean;
	readonly minVersion: "1.2" | "1.3";
	readonly certRef?: string;
	readonly keyRef?: string;
	/** PEM CA bundle used to verify mTLS client certificates. */
	readonly clientCaRef?: string;
}

interface RpcNetworkAddress {
	readonly host: string;
	readonly port: number;
	readonly auth?: RpcTransportAuthConfig;
	readonly tls?: RpcTransportTlsConfig;
	readonly allowRemote?: boolean;
}

export interface TcpRpcAddress extends RpcNetworkAddress {
	readonly transport: "tcp";
}

export interface WebsocketRpcAddress extends RpcNetworkAddress {
	readonly transport: "websocket";
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
const SECURE_WEBSOCKET_SCHEME_PREFIX = "wss://";

const INVALID_TCP_ADDRESS_MESSAGE =
	"TCP transport address must be tcp://<host>:<port> without credentials, path, query, or fragment.";
const INVALID_WEBSOCKET_ADDRESS_MESSAGE =
	"WebSocket transport address must be ws:// or wss://<host>:<port> with the optional /rpc path and without credentials, query, or fragment.";
function invalidAddress(message: string): RpcTransportAddressParseResult {
	return {
		error: new RpcTransportAddressError("rpc_transport_address_invalid", message),
	};
}

/**
 * Parse supported Automation Host network address forms.
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
			: value.startsWith(WEBSOCKET_SCHEME_PREFIX) || value.startsWith(SECURE_WEBSOCKET_SCHEME_PREFIX)
				? "websocket"
				: undefined;
	if (transport === undefined) return invalidAddress(INVALID_TCP_ADDRESS_MESSAGE);
	const invalidMessage =
		transport === "tcp" ? INVALID_TCP_ADDRESS_MESSAGE : INVALID_WEBSOCKET_ADDRESS_MESSAGE;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalidAddress(invalidMessage);
	}

	const secureWebsocket = transport === "websocket" && url.protocol === "wss:";
	if (url.protocol !== (transport === "tcp" ? "tcp:" : secureWebsocket ? "wss:" : "ws:")) {
		return invalidAddress(invalidMessage);
	}
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
	if (
		url.hostname.length === 0 ||
		url.hostname.startsWith("[") ||
		url.hostname.includes(":") ||
		url.hostname.includes("%")
	) {
		return invalidAddress(invalidMessage);
	}
	const authorityEnd = pathStart;
	const authority = authorityEnd === -1 ? value : value.slice(0, authorityEnd);
	const rawHost = authority.slice(authority.indexOf("://") + 3, authority.lastIndexOf(":"));
	if (rawHost !== url.hostname) return invalidAddress(invalidMessage);
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
				? { transport, host: url.hostname, port }
				: {
						transport,
						host: url.hostname,
						port,
						path: RPC_WEBSOCKET_DEFAULT_PATH,
						...(secureWebsocket ? { tls: { enabled: true, minVersion: "1.2" as const } } : {}),
					},
	};
}

/** Validate a structured network address used by the client or listener. */
export function validateRpcTransportAddress(value: unknown): RpcTransportAddress {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_TCP_ADDRESS_MESSAGE);
	}

	const candidate = value as {
		transport?: unknown;
		host?: unknown;
		port?: unknown;
		path?: unknown;
		auth?: unknown;
		tls?: unknown;
		allowRemote?: unknown;
	};
	if (candidate.transport !== "tcp" && candidate.transport !== "websocket") {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", INVALID_TCP_ADDRESS_MESSAGE);
	}
	const invalidMessage =
		candidate.transport === "tcp" ? INVALID_TCP_ADDRESS_MESSAGE : INVALID_WEBSOCKET_ADDRESS_MESSAGE;
	if (
		typeof candidate.host !== "string" ||
		candidate.host.length === 0 ||
		candidate.host.trim() !== candidate.host ||
		candidate.host.startsWith("[") ||
		candidate.host.includes(":") ||
		candidate.host.includes("%") ||
		!isCanonicalHost(candidate.host)
	) {
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
	const auth = validateAuthConfig(candidate.auth, invalidMessage);
	const tls = validateTlsConfig(candidate.tls, invalidMessage);
	if (candidate.allowRemote !== undefined && typeof candidate.allowRemote !== "boolean") {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}

	return candidate.transport === "tcp"
		? {
				transport: "tcp",
				host: candidate.host,
				port: candidate.port,
				...(auth === undefined ? {} : { auth }),
				...(tls === undefined ? {} : { tls }),
				...(candidate.allowRemote === undefined ? {} : { allowRemote: candidate.allowRemote }),
			}
		: {
				transport: "websocket",
				host: candidate.host,
				port: candidate.port,
				path: RPC_WEBSOCKET_DEFAULT_PATH,
				...(auth === undefined ? {} : { auth }),
				...(tls === undefined ? {} : { tls }),
				...(candidate.allowRemote === undefined ? {} : { allowRemote: candidate.allowRemote }),
			};
}

function isCanonicalHost(host: string): boolean {
	try {
		return new URL(`tcp://${host}:1`).hostname === host;
	} catch {
		return false;
	}
}

function validateAuthConfig(value: unknown, invalidMessage: string): RpcTransportAuthConfig | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	const candidate = value as { scheme?: unknown; bearerToken?: unknown };
	if (candidate.scheme !== "none" && candidate.scheme !== "bearer" && candidate.scheme !== "mtls") {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	if (
		(candidate.scheme === "bearer" &&
			(typeof candidate.bearerToken !== "string" || candidate.bearerToken.length === 0)) ||
		(candidate.scheme !== "bearer" && candidate.bearerToken !== undefined)
	) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	return candidate.scheme === "bearer"
		? { scheme: "bearer", bearerToken: candidate.bearerToken as string }
		: { scheme: candidate.scheme };
}

function validateTlsConfig(value: unknown, invalidMessage: string): RpcTransportTlsConfig | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	const candidate = value as {
		enabled?: unknown;
		minVersion?: unknown;
		certRef?: unknown;
		keyRef?: unknown;
		clientCaRef?: unknown;
	};
	if (
		typeof candidate.enabled !== "boolean" ||
		(candidate.minVersion !== "1.2" && candidate.minVersion !== "1.3") ||
		(candidate.certRef !== undefined && typeof candidate.certRef !== "string") ||
		(candidate.keyRef !== undefined && typeof candidate.keyRef !== "string") ||
		(candidate.clientCaRef !== undefined && typeof candidate.clientCaRef !== "string")
	) {
		throw new RpcTransportAddressError("rpc_transport_address_invalid", invalidMessage);
	}
	return {
		enabled: candidate.enabled,
		minVersion: candidate.minVersion,
		...(candidate.certRef === undefined ? {} : { certRef: candidate.certRef }),
		...(candidate.keyRef === undefined ? {} : { keyRef: candidate.keyRef }),
		...(candidate.clientCaRef === undefined ? {} : { clientCaRef: candidate.clientCaRef }),
	};
}

export function isRpcTransportAddressError(value: unknown): value is RpcTransportAddressError {
	return value instanceof RpcTransportAddressError;
}

export function formatRpcTransportAddress(address: RpcTransportAddress): string {
	return address.transport === "tcp"
		? `tcp://${address.host}:${address.port}`
		: `${address.tls?.enabled === true ? "wss" : "ws"}://${address.host}:${address.port}${address.path}`;
}
