/** Package-private validation for the External Connector JSONL process SPI. */

import { Buffer } from "node:buffer";
import {
	canonicalFoundationJson,
	validateConnectorCapabilitySnapshot,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
} from "@aos-agent/agent-core";
import {
	isCanonicalExternalConnectorMappingTimestamp,
	isExternalConnectorMappingIdentifier,
} from "../session-mapping.ts";
import {
	isExternalConnectorDriverEvent,
	isExternalConnectorDriverHandle,
	isExternalConnectorDriverLookup,
	isExternalConnectorTerminalEvidence,
	type ExternalConnectorDriverEvent,
	type ExternalConnectorDriverHandle,
	type ExternalConnectorDriverLookup,
	type ExternalConnectorTerminalEvidence,
} from "./types.ts";

export const EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION = 1 as const;
export const EXTERNAL_CONNECTOR_JSONL_MAX_FRAME_BYTES = 256 * 1024;

export const EXTERNAL_CONNECTOR_JSONL_OPERATIONS = Object.freeze([
	"spawn",
	"events",
	"connect",
	"lookup",
	"read",
	"write",
	"heartbeat",
	"cancel",
	"dispose",
] as const);

export const EXTERNAL_CONNECTOR_JSONL_IMPLEMENTED_OPERATIONS = Object.freeze([
	...EXTERNAL_CONNECTOR_JSONL_OPERATIONS,
	"tool_gateway_request",
	"tool_gateway_result",
] as const);

export type ExternalConnectorJsonlOperation = (typeof EXTERNAL_CONNECTOR_JSONL_OPERATIONS)[number];
export type ExternalConnectorJsonlImplementedOperation =
	(typeof EXTERNAL_CONNECTOR_JSONL_IMPLEMENTED_OPERATIONS)[number];

export interface ExternalConnectorJsonlHandshakeRequest {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "handshake";
	readonly requestId: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly protocolVersion: typeof EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION;
	readonly providerId: string;
	readonly version: string;
	readonly capability: ConnectorCapabilitySnapshot;
}

export interface ExternalConnectorJsonlHandshakeResult {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "handshake_result";
	readonly requestId: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly protocolVersion: typeof EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION;
	readonly providerId: string;
	readonly version: string;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly implementedOperations: readonly ExternalConnectorJsonlImplementedOperation[];
}

export interface ExternalConnectorJsonlRequestFrame {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "request";
	readonly requestId: string;
	readonly operation: ExternalConnectorJsonlOperation;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly payload: FoundationJsonValue;
}

export interface ExternalConnectorJsonlResponseFrame {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "response";
	readonly requestId: string;
	readonly operation: ExternalConnectorJsonlOperation;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly result: FoundationJsonValue;
}

export interface ExternalConnectorJsonlErrorFrame {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "error";
	readonly requestId: string;
	readonly operation: ExternalConnectorJsonlOperation | "handshake";
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly code: string;
	readonly message: string;
}

export interface ExternalConnectorJsonlEventFrame {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "event";
	readonly streamId: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly event: ExternalConnectorDriverEvent;
}

export interface ExternalConnectorJsonlEventsEndFrame {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION;
	readonly type: "events_end";
	readonly streamId: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
}

export type ExternalConnectorJsonlFrame =
	| ExternalConnectorJsonlHandshakeResult
	| ExternalConnectorJsonlResponseFrame
	| ExternalConnectorJsonlErrorFrame
	| ExternalConnectorJsonlEventFrame
	| ExternalConnectorJsonlEventsEndFrame;

const HANDSHAKE_REQUEST_KEYS = new Set([
	"schemaVersion",
	"type",
	"requestId",
	"supervisorRef",
	"operationNonce",
	"protocolVersion",
	"providerId",
	"version",
	"capability",
]);
const HANDSHAKE_RESULT_KEYS = new Set([
	"schemaVersion",
	"type",
	"requestId",
	"supervisorRef",
	"operationNonce",
	"protocolVersion",
	"providerId",
	"version",
	"capability",
	"implementedOperations",
]);
const REQUEST_KEYS = new Set([
	"schemaVersion",
	"type",
	"requestId",
	"operation",
	"supervisorRef",
	"operationNonce",
	"payload",
]);
const RESPONSE_KEYS = new Set([
	"schemaVersion",
	"type",
	"requestId",
	"operation",
	"supervisorRef",
	"operationNonce",
	"result",
]);
const ERROR_KEYS = new Set([
	"schemaVersion",
	"type",
	"requestId",
	"operation",
	"supervisorRef",
	"operationNonce",
	"code",
	"message",
]);
const EVENT_KEYS = new Set([
	"schemaVersion",
	"type",
	"streamId",
	"supervisorRef",
	"operationNonce",
	"event",
]);
const EVENTS_END_KEYS = new Set(["schemaVersion", "type", "streamId", "supervisorRef", "operationNonce"]);
const OPERATION_SET: ReadonlySet<string> = new Set(EXTERNAL_CONNECTOR_JSONL_OPERATIONS);
const IMPLEMENTED_OPERATION_SET: ReadonlySet<string> = new Set(EXTERNAL_CONNECTOR_JSONL_IMPLEMENTED_OPERATIONS);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.size && ownKeys.every((key) => typeof key === "string" && keys.has(key));
}

function isIdentifier(value: unknown): value is string {
	return isExternalConnectorMappingIdentifier(value) && IDENTIFIER_PATTERN.test(value);
}

function isVersion(value: unknown): value is string {
	return typeof value === "string" && VERSION_PATTERN.test(value);
}

function isFoundationJsonValue(value: unknown): value is FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
		return true;
	} catch {
		return false;
	}
}

function isCapability(value: unknown): value is ConnectorCapabilitySnapshot {
	return validateConnectorCapabilitySnapshot(value).ok;
}

function isOperation(value: unknown): value is ExternalConnectorJsonlOperation {
	return typeof value === "string" && OPERATION_SET.has(value);
}

function isImplementedOperation(value: unknown): value is ExternalConnectorJsonlImplementedOperation {
	return typeof value === "string" && IMPLEMENTED_OPERATION_SET.has(value);
}

function isCommonFrame(
	value: Record<string, unknown>,
	keys: ReadonlySet<string>,
	requestType: string,
): boolean {
	return (
		hasExactKeys(value, keys) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION &&
		value.type === requestType &&
		isIdentifier(value.requestId) &&
		isIdentifier(value.supervisorRef) &&
		isIdentifier(value.operationNonce)
	);
}

function isHandshakeResult(value: unknown): value is ExternalConnectorJsonlHandshakeResult {
	if (!isRecord(value)) return false;
	return (
		isCommonFrame(value, HANDSHAKE_RESULT_KEYS, "handshake_result") &&
		value.protocolVersion === EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION &&
		isIdentifier(value.providerId) &&
		isVersion(value.version) &&
		isCapability(value.capability) &&
		Array.isArray(value.implementedOperations) &&
		value.implementedOperations.length > 0 &&
		value.implementedOperations.every(isImplementedOperation) &&
		new Set(value.implementedOperations).size === value.implementedOperations.length
	);
}

function isResponse(value: unknown): value is ExternalConnectorJsonlResponseFrame {
	if (!isRecord(value)) return false;
	return isCommonFrame(value, RESPONSE_KEYS, "response") && isOperation(value.operation) && isFoundationJsonValue(value.result);
}

function isError(value: unknown): value is ExternalConnectorJsonlErrorFrame {
	if (!isRecord(value)) return false;
	return (
		isCommonFrame(value, ERROR_KEYS, "error") &&
		(typeof value.operation === "string" && (isOperation(value.operation) || value.operation === "handshake")) &&
		typeof value.code === "string" &&
		ERROR_CODE_PATTERN.test(value.code) &&
		typeof value.message === "string" &&
		value.message.length > 0 &&
		value.message.length <= 512
	);
}

function isEvent(value: unknown): value is ExternalConnectorJsonlEventFrame {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, EVENT_KEYS) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION &&
		value.type === "event" &&
		isIdentifier(value.streamId) &&
		isIdentifier(value.supervisorRef) &&
		isIdentifier(value.operationNonce) &&
		isExternalConnectorDriverEvent(value.event)
	);
}

function isEventsEnd(value: unknown): value is ExternalConnectorJsonlEventsEndFrame {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, EVENTS_END_KEYS) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION &&
		value.type === "events_end" &&
		isIdentifier(value.streamId) &&
		isIdentifier(value.supervisorRef) &&
		isIdentifier(value.operationNonce)
	);
}

/** Parse exactly one bounded JSONL frame emitted by an external driver. */
export function parseExternalConnectorJsonlFrame(line: string): ExternalConnectorJsonlFrame {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > EXTERNAL_CONNECTOR_JSONL_MAX_FRAME_BYTES) {
		throw new TypeError("External Connector JSONL frame exceeds its size limit");
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new TypeError("External Connector JSONL frame is not valid JSON");
	}
	if (!isRecord(value)) throw new TypeError("External Connector JSONL frame must be an object");
	if (isHandshakeResult(value) || isResponse(value) || isError(value) || isEvent(value) || isEventsEnd(value)) {
		return value;
	}
	throw new TypeError("External Connector JSONL frame has an unsupported shape");
}

/** Validate a Host-to-driver handshake frame before it is written. */
export function isExternalConnectorJsonlHandshakeRequest(
	value: unknown,
): value is ExternalConnectorJsonlHandshakeRequest {
	if (!isRecord(value) || !isCommonFrame(value, HANDSHAKE_REQUEST_KEYS, "handshake")) return false;
	return (
		value.protocolVersion === EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION &&
		isIdentifier(value.providerId) &&
		isVersion(value.version) &&
		isCapability(value.capability)
	);
}

/** Validate a Host-to-driver request frame before it is written. */
export function isExternalConnectorJsonlRequestFrame(value: unknown): value is ExternalConnectorJsonlRequestFrame {
	if (!isRecord(value) || !isCommonFrame(value, REQUEST_KEYS, "request")) return false;
	return isOperation(value.operation) && isFoundationJsonValue(value.payload);
}

/** Narrow result payloads only after the frame's request correlation is proven. */
export function isExternalConnectorJsonlOperationResult(
	operation: ExternalConnectorJsonlOperation,
	value: unknown,
): value is ExternalConnectorDriverHandle | ExternalConnectorDriverLookup | ExternalConnectorTerminalEvidence | FoundationJsonValue {
	if (operation === "spawn" || operation === "connect") return isExternalConnectorDriverHandle(value);
	if (operation === "lookup") return isExternalConnectorDriverLookup(value);
	if (operation === "read") return isExternalConnectorTerminalEvidence(value);
	if (operation === "cancel") return value === null || value === undefined || isExternalConnectorTerminalEvidence(value);
	return isFoundationJsonValue(value);
}

/** JSONL payloads never carry a Host AbortSignal or other non-JSON value. */
export function assertExternalConnectorJsonlFrameSize(value: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new TypeError("External Connector JSONL frame is not serializable");
	}
	if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > EXTERNAL_CONNECTOR_JSONL_MAX_FRAME_BYTES) {
		throw new TypeError("External Connector JSONL frame exceeds its size limit");
	}
	return serialized;
}

export function isExternalConnectorJsonlTimestamp(value: unknown): value is string {
	return isCanonicalExternalConnectorMappingTimestamp(value);
}
