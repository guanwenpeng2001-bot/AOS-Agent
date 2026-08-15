import { describe, expect, test } from "vitest";
import {
	formatRpcTransportAddress,
	parseRpcTransportAddress,
	RPC_TRANSPORT_LOOPBACK_HOST,
	RPC_TRANSPORT_PORT_MAX,
	RPC_TRANSPORT_PORT_MIN,
	RpcTransportAddressError,
	validateRpcTransportAddress,
	type RpcTransportAddressErrorCode,
} from "../src/modes/rpc/rpc-transport-address.ts";

function expectAddress(value: string, port: number): void {
	expect(parseRpcTransportAddress(value)).toEqual({
		address: {
			transport: "tcp",
			host: RPC_TRANSPORT_LOOPBACK_HOST,
			port,
		},
	});
}

function expectError(value: string, code: RpcTransportAddressErrorCode): RpcTransportAddressError {
	const result = parseRpcTransportAddress(value);
	if (!("error" in result)) {
		throw new Error(`Expected ${value} to be rejected`);
	}

	expect(result.error).toBeInstanceOf(RpcTransportAddressError);
	expect(result.error.code).toBe(code);
	return result.error;
}

describe("RPC TCP transport address", () => {
	test.each([
		["tcp://127.0.0.1:1", RPC_TRANSPORT_PORT_MIN],
		["tcp://127.0.0.1:4123", 4123],
		["tcp://127.0.0.1:65535", RPC_TRANSPORT_PORT_MAX],
	])("accepts %s", (value, port) => {
		expectAddress(value, port);
	});

	test("formats the canonical loopback address", () => {
		expect(formatRpcTransportAddress({ transport: "tcp", host: "127.0.0.1", port: 4123 })).toBe(
			"tcp://127.0.0.1:4123",
		);
	});

	test.each([
		["tcp://localhost:4123", "rpc_transport_not_loopback"],
		["tcp://0.0.0.0:4123", "rpc_transport_not_loopback"],
		["tcp://127.0.0.2:4123", "rpc_transport_not_loopback"],
		["tcp://192.168.1.10:4123", "rpc_transport_not_loopback"],
		["tcp://203.0.113.10:4123", "rpc_transport_not_loopback"],
		["tcp://127.0.0.1%2e:4123", "rpc_transport_not_loopback"],
		["tcp://[::1]:4123", "rpc_transport_address_invalid"],
		["tcp://[::ffff:127.0.0.1]:4123", "rpc_transport_address_invalid"],
		["tcp://::1:4123", "rpc_transport_address_invalid"],
	] as const)("rejects unsupported host %s", (value, code) => {
		expectError(value, code);
	});

	test.each([
		"tcp://user@127.0.0.1:4123",
		"tcp://:secret@127.0.0.1:4123",
		"tcp://user:secret@127.0.0.1:4123",
	])("rejects credentials in %s", (value) => {
		const error = expectError(value, "rpc_transport_address_invalid");
		expect(error.message).not.toContain("secret");
	});

	test.each([
		"tcp://127.0.0.1:4123/",
		"tcp://127.0.0.1:4123/path",
		"tcp://127.0.0.1:4123?query=value",
		"tcp://127.0.0.1:4123?",
		"tcp://127.0.0.1:4123#fragment",
		"tcp://127.0.0.1:4123#",
	])("rejects URL components in %s", (value) => {
		expectError(value, "rpc_transport_address_invalid");
	});

	test.each([
		"tcp://127.0.0.1",
		"tcp://127.0.0.1:",
		"tcp://127.0.0.1:0",
		"tcp://127.0.0.1:65536",
		"tcp://127.0.0.1:99999",
		"tcp://127.0.0.1:-1",
		"tcp://127.0.0.1:1.5",
		"tcp://127.0.0.1:1e3",
		"tcp://127.0.0.1:+1",
		"tcp://127.0.0.1:01",
		"tcp://127.0.0.1:00042",
		"tcp://127.0.0.1:1 2",
		"tcp://127.0.0.1:１２３",
	])("rejects invalid port in %s", (value) => {
		expectError(value, "rpc_transport_address_invalid");
	});

	test.each([
		"http://127.0.0.1:4123",
		"TCP://127.0.0.1:4123",
		"tcp:/127.0.0.1:4123",
		"tcp://127.0.0.1:4123/../other",
		" tcp://127.0.0.1:4123",
		"tcp://127.0.0.1:4123 ",
	])("rejects malformed transport address %s", (value) => {
		expectError(value, "rpc_transport_address_invalid");
	});

	test.each([0, 65_536, 1.5, Number.NaN])("rejects structured port %s", (port) => {
		expect(() => validateRpcTransportAddress({ transport: "tcp", host: "127.0.0.1", port })).toThrowError(
			RpcTransportAddressError,
		);
	});
});
