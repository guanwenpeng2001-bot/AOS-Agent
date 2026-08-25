import { Result, type Result as ResultValue } from "../result.ts";
import { redactText } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { canonicalFoundationJson } from "./identity.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import type { FoundationError } from "./errors.ts";

export const PROTOCOL_VERSION = 1 as const;
export const FOUNDATION_PROTOCOL_VERSION = PROTOCOL_VERSION;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type EndpointKind = "stdio" | "tcp" | "websocket";
export type FramingKind = "jsonl" | "length_prefixed" | "frame";
export type AuthScheme = "none" | "bearer" | "mtls";
export type ProtocolMessageKind = "initialize" | "initialize_result" | "command" | "snapshot" | "event" | "receipt" | "ack" | "error" | "auth_challenge" | "auth_response";
export type ProtocolFeature = "observer.attach" | "observer.cursor" | "observer.gap" | "events.durable" | "events.live" | "events.derived" | "run.receipt" | "command.idempotency" | "transport.stdio" | "transport.tcp" | "transport.websocket" | "transport.auth" | "transport.tls" | "protocol.migration";
export interface ProtocolRange { min: number; max: number; }
export interface ProtocolCapabilities { versions: ProtocolRange; features: readonly ProtocolFeature[]; }
export interface ProtocolNegotiation { version: number; features: readonly ProtocolFeature[]; compatible: ProtocolRange; }
export class ProtocolError extends Error { readonly _tag = "ProtocolErrorV1" as const; readonly code: ProtocolErrorCode; constructor(code: ProtocolErrorCode, message: string) { super(redactText(message)); this.name = "ProtocolErrorV1"; this.code = code; } }
export type ProtocolErrorCode = "protocol_version_invalid_range" | "protocol_unsupported_version" | "protocol_no_common_features" | "protocol_feature_unavailable" | "protocol_invalid_envelope" | "protocol_unknown_kind" | "protocol_invalid_schema_version" | "transport_invalid_endpoint" | "transport_requires_auth" | "transport_requires_tls" | "transport_requires_allow_remote" | "transport_tls_invalid_config" | "transport_not_authorized";
export const PROTOCOL_FEATURE_MATRIX: Readonly<Record<number, readonly ProtocolFeature[]>> = Object.freeze({ 1: ["observer.attach", "observer.cursor", "observer.gap", "events.durable", "events.live", "events.derived", "run.receipt", "command.idempotency", "transport.stdio", "transport.tcp", "transport.websocket", "transport.auth", "transport.tls", "protocol.migration"] });
export function protocolFeaturesForVersion(version: number): readonly ProtocolFeature[] | undefined { return PROTOCOL_FEATURE_MATRIX[version]; }
function validRange(range: ProtocolRange): ResultValue<ProtocolRange, ProtocolError> { return Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 1 && range.min <= range.max ? Result.ok(range) : Result.err(new ProtocolError("protocol_version_invalid_range", "protocol version range is invalid")); }
export function negotiateProtocol(server: ProtocolCapabilities, client: ProtocolCapabilities): ResultValue<ProtocolNegotiation, ProtocolError> {
	const serverRange = validRange(server.versions); if (!serverRange.ok) return serverRange; const clientRange = validRange(client.versions); if (!clientRange.ok) return clientRange;
	const floor = Math.max(server.versions.min, client.versions.min); const ceiling = Math.min(server.versions.max, client.versions.max); if (floor > ceiling) return Result.err(new ProtocolError("protocol_unsupported_version", "peers have no common protocol version"));
	const provided = new Set(server.features); const features = client.features.filter((feature) => provided.has(feature)); if (features.length === 0) return Result.err(new ProtocolError("protocol_no_common_features", "peers have no common protocol features"));
	const versionFeatures = protocolFeaturesForVersion(ceiling); if (versionFeatures === undefined) return Result.err(new ProtocolError("protocol_unsupported_version", "negotiated protocol version is not present in the feature matrix")); if (features.some((feature) => !versionFeatures.includes(feature))) return Result.err(new ProtocolError("protocol_feature_unavailable", "peer requested a feature not provided by the negotiated version"));
	return Result.ok({ version: ceiling, features, compatible: { min: floor, max: ceiling } });
}
export const ProtocolRangeSchema = {
	type: "object",
	additionalProperties: false,
	required: ["min", "max"],
	properties: { min: { type: "integer", minimum: 1 }, max: { type: "integer", minimum: 1 } },
} as const;
export const ProtocolCapabilitiesSchema = {
	type: "object",
	additionalProperties: false,
	required: ["versions", "features"],
	properties: { versions: ProtocolRangeSchema, features: { type: "array", items: { type: "string", minLength: 1 } } },
} as const;
export const ProtocolNegotiationSchema = {
	type: "object",
	additionalProperties: false,
	required: ["version", "features", "compatible"],
	properties: { version: { type: "integer", minimum: 1 }, features: { type: "array", items: { type: "string", minLength: 1 } }, compatible: ProtocolRangeSchema },
} as const;
export function validateProtocolCapabilities(value: unknown): ResultValue<ProtocolCapabilities, FoundationError> { return validateExactShape<ProtocolCapabilities>(ProtocolCapabilitiesSchema, value, "protocol_capabilities"); }
export function serializeProtocolCapabilities(value: ProtocolCapabilities): string { return serializeExactShape(ProtocolCapabilitiesSchema, value, "protocol_capabilities"); }
export function parseProtocolCapabilities(text: string): ResultValue<ProtocolCapabilities, FoundationError> { return parseExactShape(ProtocolCapabilitiesSchema, text, "protocol_capabilities"); }
export function validateProtocolNegotiation(value: unknown): ResultValue<ProtocolNegotiation, FoundationError> { return validateExactShape<ProtocolNegotiation>(ProtocolNegotiationSchema, value, "protocol_negotiation"); }
export function serializeProtocolNegotiation(value: ProtocolNegotiation): string { return serializeExactShape(ProtocolNegotiationSchema, value, "protocol_negotiation"); }
export function parseProtocolNegotiation(text: string): ResultValue<ProtocolNegotiation, FoundationError> { return parseExactShape(ProtocolNegotiationSchema, text, "protocol_negotiation"); }
export interface ProtocolMessageEnvelope<TKind extends ProtocolMessageKind = ProtocolMessageKind, TPayload = FoundationJsonValue> { schemaVersion: 1; kind: TKind; messageId: string; correlationId?: string; sessionId?: string; timestamp: string; payload: TPayload; }
export interface CreateProtocolMessageInput<TPayload = FoundationJsonValue> { kind: ProtocolMessageKind; messageId: string; correlationId?: string; sessionId?: string; timestamp: string; payload: TPayload; }
export function createProtocolMessage<TKind extends ProtocolMessageKind, TPayload>(input: CreateProtocolMessageInput<TPayload> & { kind: TKind }): ProtocolMessageEnvelope<TKind, TPayload> { canonicalFoundationJson(input.payload); return { schemaVersion: 1, kind: input.kind, messageId: input.messageId, ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), timestamp: input.timestamp, payload: input.payload }; }
const messageKinds: readonly ProtocolMessageKind[] = ["initialize", "initialize_result", "command", "snapshot", "event", "receipt", "ack", "error", "auth_challenge", "auth_response"];
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function protocolMessageKind(value: unknown): value is ProtocolMessageKind { return typeof value === "string" && messageKinds.includes(value as ProtocolMessageKind); }
function foundationJsonValue(value: unknown): value is FoundationJsonValue { try { canonicalFoundationJson(value); return true; } catch { return false; } }
export function validateProtocolMessageEnvelope(value: unknown): ResultValue<ProtocolMessageEnvelope, ProtocolError> {
	if (!plain(value) || !Object.keys(value).every((key) => ["schemaVersion", "kind", "messageId", "correlationId", "sessionId", "timestamp", "payload"].includes(key))) return Result.err(new ProtocolError("protocol_invalid_envelope", "protocol envelope has an invalid exact shape"));
	if (value.schemaVersion !== 1) return Result.err(new ProtocolError("protocol_invalid_schema_version", "unsupported protocol envelope schema version"));
	if (!protocolMessageKind(value.kind)) return Result.err(new ProtocolError("protocol_unknown_kind", "unknown protocol message kind"));
	if (typeof value.messageId !== "string" || value.messageId.length === 0 || typeof value.timestamp !== "string" || value.timestamp.length === 0 || value.payload === undefined || (value.correlationId !== undefined && (typeof value.correlationId !== "string" || value.correlationId.length === 0)) || (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length === 0))) return Result.err(new ProtocolError("protocol_invalid_envelope", "protocol envelope identifiers are invalid"));
	if (!foundationJsonValue(value.payload)) return Result.err(new ProtocolError("protocol_invalid_envelope", "protocol payload must be finite, acyclic JSON"));
	return Result.ok({ schemaVersion: 1, kind: value.kind, messageId: value.messageId, ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId }), ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }), timestamp: value.timestamp, payload: value.payload });
}
export function serializeProtocolMessageEnvelope(value: ProtocolMessageEnvelope): string { const checked = validateProtocolMessageEnvelope(value); if (!checked.ok) throw checked.error; return canonicalFoundationJson(checked.value); }
export function parseProtocolMessageEnvelope(text: string): ResultValue<ProtocolMessageEnvelope, ProtocolError> { try { return validateProtocolMessageEnvelope(JSON.parse(text) as unknown); } catch { return Result.err(new ProtocolError("protocol_invalid_envelope", "protocol message is not valid JSON")); } }
export interface InitializeRequest { client: ProtocolCapabilities; }
export interface InitializeResult { server: ProtocolCapabilities; negotiated: ProtocolNegotiation; serverId: string; }
export function createInitializeResult(server: ProtocolCapabilities, client: ProtocolCapabilities, serverId: string): ResultValue<InitializeResult, ProtocolError> { const negotiated = negotiateProtocol(server, client); return negotiated.ok ? Result.ok({ server, negotiated: negotiated.value, serverId }) : negotiated; }
export function initializeRequestEnvelope(client: ProtocolCapabilities, opts: { messageId: string; timestamp: string }): ProtocolMessageEnvelope<"initialize", InitializeRequest> { return createProtocolMessage({ kind: "initialize", messageId: opts.messageId, timestamp: opts.timestamp, payload: { client } }); }
export function initializeResultEnvelope(result: InitializeResult, opts: { messageId: string; timestamp: string; correlationId?: string }): ProtocolMessageEnvelope<"initialize_result", InitializeResult> { return createProtocolMessage({ kind: "initialize_result", messageId: opts.messageId, timestamp: opts.timestamp, correlationId: opts.correlationId, payload: result }); }
export interface ProtocolCommand { commandId: string; clientRequestId: string; command: string; args: FoundationJsonValue; }
export function commandEnvelope(command: ProtocolCommand, opts: { messageId: string; timestamp: string; sessionId?: string; correlationId?: string }): ProtocolMessageEnvelope<"command", ProtocolCommand> { return createProtocolMessage({ kind: "command", messageId: opts.messageId, timestamp: opts.timestamp, sessionId: opts.sessionId, correlationId: opts.correlationId, payload: command }); }
export interface TlsServerConfig { enabled: boolean; minVersion: "1.2" | "1.3"; certRef?: string; keyRef?: string; }
export interface EndpointAuthConfig { scheme: AuthScheme; }
export interface TransportEndpointConfig { kind: EndpointKind; host?: string; port?: number; auth?: EndpointAuthConfig; tls?: TlsServerConfig; allowRemote: boolean; }
export interface EndpointSecurityVerdict { kind: EndpointKind; loopback: boolean; authScheme: AuthScheme; tlsEnabled: boolean; allowRemote: boolean; }
export function isLoopbackHost(host: string): boolean { const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true; if (!/^127\.\d{1,3}(\.\d{1,3}){2}$/.test(normalized)) return false; return normalized.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255); }
export function transportFraming(kind: EndpointKind): FramingKind { return kind === "stdio" ? "jsonl" : kind === "tcp" ? "length_prefixed" : "frame"; }
export function validateTlsServerConfig(tls: TlsServerConfig | undefined): ResultValue<null, ProtocolError> { if (tls === undefined || tls.enabled === false) return Result.ok(null); if (tls.minVersion !== "1.2" && tls.minVersion !== "1.3") return Result.err(new ProtocolError("transport_tls_invalid_config", "TLS minimum version is invalid")); if (!tls.certRef || !tls.keyRef) return Result.err(new ProtocolError("transport_tls_invalid_config", "enabled TLS requires credential references")); return Result.ok(null); }
export function validateEndpointSecurity(config: TransportEndpointConfig): ResultValue<EndpointSecurityVerdict, ProtocolError> {
	if (!["stdio", "tcp", "websocket"].includes(config.kind)) return Result.err(new ProtocolError("transport_invalid_endpoint", "endpoint kind is invalid")); const tls = validateTlsServerConfig(config.tls); if (!tls.ok) return tls;
	if (config.kind === "stdio") return Result.ok({ kind: config.kind, loopback: true, authScheme: config.auth?.scheme ?? "none", tlsEnabled: config.tls?.enabled ?? false, allowRemote: config.allowRemote });
	const loopback = isLoopbackHost(config.host ?? "127.0.0.1"); if (loopback) return Result.ok({ kind: config.kind, loopback, authScheme: config.auth?.scheme ?? "none", tlsEnabled: config.tls?.enabled ?? false, allowRemote: config.allowRemote });
	if ((config.auth?.scheme ?? "none") === "none") return Result.err(new ProtocolError("transport_requires_auth", "non-loopback endpoint requires authentication")); if (config.tls?.enabled !== true) return Result.err(new ProtocolError("transport_requires_tls", "non-loopback endpoint requires TLS")); if (!config.allowRemote) return Result.err(new ProtocolError("transport_requires_allow_remote", "remote endpoint requires explicit allowRemote"));
	return Result.ok({ kind: config.kind, loopback: false, authScheme: config.auth!.scheme, tlsEnabled: true, allowRemote: true });
}
export interface AuthProof { bearerTokenProvided?: boolean; clientCertificatePresent?: boolean; }
export function authenticateConnection(config: TransportEndpointConfig, proof: AuthProof): ResultValue<null, ProtocolError> { const scheme = config.auth?.scheme ?? "none"; if (scheme === "none") return Result.ok(null); if (scheme === "bearer" && proof.bearerTokenProvided === true) return Result.ok(null); if (scheme === "mtls" && proof.clientCertificatePresent === true) return Result.ok(null); return Result.err(new ProtocolError("transport_not_authorized", "connection authentication proof is missing")); }
