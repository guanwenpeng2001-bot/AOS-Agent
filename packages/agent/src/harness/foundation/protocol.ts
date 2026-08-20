import { Result, type Result as ResultValue } from "../result.ts";
import { redactText } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { canonicalFoundationJson } from "./identity.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import type { FoundationError } from "./errors.ts";

export const PROTOCOL_VERSION_V1 = 1 as const;
export const FOUNDATION_PROTOCOL_VERSION = PROTOCOL_VERSION_V1;
export type ProtocolVersionV1 = typeof PROTOCOL_VERSION_V1;
export type EndpointKindV1 = "stdio" | "tcp" | "websocket";
export type FramingKindV1 = "jsonl" | "length_prefixed" | "frame";
export type AuthSchemeV1 = "none" | "bearer" | "mtls";
export type ProtocolMessageKindV1 = "initialize" | "initialize_result" | "command" | "snapshot" | "event" | "receipt" | "ack" | "error" | "auth_challenge" | "auth_response";
export type ProtocolFeatureV1 = "observer.attach" | "observer.cursor" | "observer.gap" | "events.durable" | "events.live" | "events.derived" | "run.receipt" | "command.idempotency" | "transport.stdio" | "transport.tcp" | "transport.websocket" | "transport.auth" | "transport.tls" | "protocol.migration";
export type ProtocolFeature = ProtocolFeatureV1;
export interface ProtocolRangeV1 { min: number; max: number; }
export interface ProtocolCapabilitiesV1 { versions: ProtocolRangeV1; features: readonly ProtocolFeatureV1[]; }
export interface ProtocolNegotiationV1 { version: number; features: readonly ProtocolFeatureV1[]; compatible: ProtocolRangeV1; }
export type ProtocolCapabilities = ProtocolCapabilitiesV1;
export class ProtocolErrorV1 extends Error { readonly _tag = "ProtocolErrorV1" as const; readonly code: ProtocolErrorCodeV1; constructor(code: ProtocolErrorCodeV1, message: string) { super(redactText(message)); this.name = "ProtocolErrorV1"; this.code = code; } }
export type ProtocolErrorCodeV1 = "protocol_version_invalid_range" | "protocol_unsupported_version" | "protocol_no_common_features" | "protocol_feature_unavailable" | "protocol_invalid_envelope" | "protocol_unknown_kind" | "protocol_invalid_schema_version" | "transport_invalid_endpoint" | "transport_requires_auth" | "transport_requires_tls" | "transport_requires_allow_remote" | "transport_tls_invalid_config" | "transport_not_authorized";
export const PROTOCOL_FEATURE_MATRIX_V1: Readonly<Record<number, readonly ProtocolFeatureV1[]>> = Object.freeze({ 1: ["observer.attach", "observer.cursor", "observer.gap", "events.durable", "events.live", "events.derived", "run.receipt", "command.idempotency", "transport.stdio", "transport.tcp", "transport.websocket", "transport.auth", "transport.tls", "protocol.migration"] });
export function protocolFeaturesForVersionV1(version: number): readonly ProtocolFeatureV1[] | undefined { return PROTOCOL_FEATURE_MATRIX_V1[version]; }
function validRange(range: ProtocolRangeV1): ResultValue<ProtocolRangeV1, ProtocolErrorV1> { return Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 1 && range.min <= range.max ? Result.ok(range) : Result.err(new ProtocolErrorV1("protocol_version_invalid_range", "protocol version range is invalid")); }
export function negotiateProtocolV1(server: ProtocolCapabilitiesV1, client: ProtocolCapabilitiesV1): ResultValue<ProtocolNegotiationV1, ProtocolErrorV1> {
	const serverRange = validRange(server.versions); if (!serverRange.ok) return serverRange; const clientRange = validRange(client.versions); if (!clientRange.ok) return clientRange;
	const floor = Math.max(server.versions.min, client.versions.min); const ceiling = Math.min(server.versions.max, client.versions.max); if (floor > ceiling) return Result.err(new ProtocolErrorV1("protocol_unsupported_version", "peers have no common protocol version"));
	const provided = new Set(server.features); const features = client.features.filter((feature) => provided.has(feature)); if (features.length === 0) return Result.err(new ProtocolErrorV1("protocol_no_common_features", "peers have no common protocol features"));
	const versionFeatures = protocolFeaturesForVersionV1(ceiling); if (versionFeatures === undefined) return Result.err(new ProtocolErrorV1("protocol_unsupported_version", "negotiated protocol version is not present in the feature matrix")); if (features.some((feature) => !versionFeatures.includes(feature))) return Result.err(new ProtocolErrorV1("protocol_feature_unavailable", "peer requested a feature not provided by the negotiated version"));
	return Result.ok({ version: ceiling, features, compatible: { min: floor, max: ceiling } });
}
export const negotiateProtocol = negotiateProtocolV1;
export const ProtocolRangeV1Schema = {
	type: "object",
	additionalProperties: false,
	required: ["min", "max"],
	properties: { min: { type: "integer", minimum: 1 }, max: { type: "integer", minimum: 1 } },
} as const;
export const ProtocolCapabilitiesV1Schema = {
	type: "object",
	additionalProperties: false,
	required: ["versions", "features"],
	properties: { versions: ProtocolRangeV1Schema, features: { type: "array", items: { type: "string", minLength: 1 } } },
} as const;
export const ProtocolNegotiationV1Schema = {
	type: "object",
	additionalProperties: false,
	required: ["version", "features", "compatible"],
	properties: { version: { type: "integer", minimum: 1 }, features: { type: "array", items: { type: "string", minLength: 1 } }, compatible: ProtocolRangeV1Schema },
} as const;
export function validateProtocolCapabilitiesV1(value: unknown): ResultValue<ProtocolCapabilitiesV1, FoundationError> { return validateExactShape<ProtocolCapabilitiesV1>(ProtocolCapabilitiesV1Schema, value, "protocol_capabilities"); }
export function serializeProtocolCapabilitiesV1(value: ProtocolCapabilitiesV1): string { return serializeExactShape(ProtocolCapabilitiesV1Schema, value, "protocol_capabilities"); }
export function parseProtocolCapabilitiesV1(text: string): ResultValue<ProtocolCapabilitiesV1, FoundationError> { return parseExactShape(ProtocolCapabilitiesV1Schema, text, "protocol_capabilities"); }
export function validateProtocolNegotiationV1(value: unknown): ResultValue<ProtocolNegotiationV1, FoundationError> { return validateExactShape<ProtocolNegotiationV1>(ProtocolNegotiationV1Schema, value, "protocol_negotiation"); }
export function serializeProtocolNegotiationV1(value: ProtocolNegotiationV1): string { return serializeExactShape(ProtocolNegotiationV1Schema, value, "protocol_negotiation"); }
export function parseProtocolNegotiationV1(text: string): ResultValue<ProtocolNegotiationV1, FoundationError> { return parseExactShape(ProtocolNegotiationV1Schema, text, "protocol_negotiation"); }
export interface ProtocolMessageEnvelopeV1<TKind extends ProtocolMessageKindV1 = ProtocolMessageKindV1, TPayload = FoundationJsonValue> { schemaVersion: 1; kind: TKind; messageId: string; correlationId?: string; sessionId?: string; timestamp: string; payload: TPayload; }
export interface CreateProtocolMessageInputV1<TPayload = FoundationJsonValue> { kind: ProtocolMessageKindV1; messageId: string; correlationId?: string; sessionId?: string; timestamp: string; payload: TPayload; }
export function createProtocolMessageV1<TKind extends ProtocolMessageKindV1, TPayload>(input: CreateProtocolMessageInputV1<TPayload> & { kind: TKind }): ProtocolMessageEnvelopeV1<TKind, TPayload> { canonicalFoundationJson(input.payload); return { schemaVersion: 1, kind: input.kind, messageId: input.messageId, ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), timestamp: input.timestamp, payload: input.payload }; }
const messageKinds: readonly ProtocolMessageKindV1[] = ["initialize", "initialize_result", "command", "snapshot", "event", "receipt", "ack", "error", "auth_challenge", "auth_response"];
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function protocolMessageKind(value: unknown): value is ProtocolMessageKindV1 { return typeof value === "string" && messageKinds.includes(value as ProtocolMessageKindV1); }
function foundationJsonValue(value: unknown): value is FoundationJsonValue { try { canonicalFoundationJson(value); return true; } catch { return false; } }
export function validateProtocolMessageEnvelopeV1(value: unknown): ResultValue<ProtocolMessageEnvelopeV1, ProtocolErrorV1> {
	if (!plain(value) || !Object.keys(value).every((key) => ["schemaVersion", "kind", "messageId", "correlationId", "sessionId", "timestamp", "payload"].includes(key))) return Result.err(new ProtocolErrorV1("protocol_invalid_envelope", "protocol envelope has an invalid exact shape"));
	if (value.schemaVersion !== 1) return Result.err(new ProtocolErrorV1("protocol_invalid_schema_version", "unsupported protocol envelope schema version"));
	if (!protocolMessageKind(value.kind)) return Result.err(new ProtocolErrorV1("protocol_unknown_kind", "unknown protocol message kind"));
	if (typeof value.messageId !== "string" || value.messageId.length === 0 || typeof value.timestamp !== "string" || value.timestamp.length === 0 || value.payload === undefined || (value.correlationId !== undefined && (typeof value.correlationId !== "string" || value.correlationId.length === 0)) || (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length === 0))) return Result.err(new ProtocolErrorV1("protocol_invalid_envelope", "protocol envelope identifiers are invalid"));
	if (!foundationJsonValue(value.payload)) return Result.err(new ProtocolErrorV1("protocol_invalid_envelope", "protocol payload must be finite, acyclic JSON"));
	return Result.ok({ schemaVersion: 1, kind: value.kind, messageId: value.messageId, ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId }), ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }), timestamp: value.timestamp, payload: value.payload });
}
export function serializeProtocolMessageEnvelopeV1(value: ProtocolMessageEnvelopeV1): string { const checked = validateProtocolMessageEnvelopeV1(value); if (!checked.ok) throw checked.error; return canonicalFoundationJson(checked.value); }
export function parseProtocolMessageEnvelopeV1(text: string): ResultValue<ProtocolMessageEnvelopeV1, ProtocolErrorV1> { try { return validateProtocolMessageEnvelopeV1(JSON.parse(text) as unknown); } catch { return Result.err(new ProtocolErrorV1("protocol_invalid_envelope", "protocol message is not valid JSON")); } }
export const validateProtocolMessageEnvelope = validateProtocolMessageEnvelopeV1;
export const serializeProtocolMessageEnvelope = serializeProtocolMessageEnvelopeV1;
export const parseProtocolMessageEnvelope = parseProtocolMessageEnvelopeV1;
export interface InitializeRequestV1 { client: ProtocolCapabilitiesV1; }
export interface InitializeResultV1 { server: ProtocolCapabilitiesV1; negotiated: ProtocolNegotiationV1; serverId: string; }
export function createInitializeResultV1(server: ProtocolCapabilitiesV1, client: ProtocolCapabilitiesV1, serverId: string): ResultValue<InitializeResultV1, ProtocolErrorV1> { const negotiated = negotiateProtocolV1(server, client); return negotiated.ok ? Result.ok({ server, negotiated: negotiated.value, serverId }) : negotiated; }
export function initializeRequestEnvelopeV1(client: ProtocolCapabilitiesV1, opts: { messageId: string; timestamp: string }): ProtocolMessageEnvelopeV1<"initialize", InitializeRequestV1> { return createProtocolMessageV1({ kind: "initialize", messageId: opts.messageId, timestamp: opts.timestamp, payload: { client } }); }
export function initializeResultEnvelopeV1(result: InitializeResultV1, opts: { messageId: string; timestamp: string; correlationId?: string }): ProtocolMessageEnvelopeV1<"initialize_result", InitializeResultV1> { return createProtocolMessageV1({ kind: "initialize_result", messageId: opts.messageId, timestamp: opts.timestamp, correlationId: opts.correlationId, payload: result }); }
export interface ProtocolCommandV1 { commandId: string; clientRequestId: string; command: string; args: FoundationJsonValue; }
export function commandEnvelopeV1(command: ProtocolCommandV1, opts: { messageId: string; timestamp: string; sessionId?: string; correlationId?: string }): ProtocolMessageEnvelopeV1<"command", ProtocolCommandV1> { return createProtocolMessageV1({ kind: "command", messageId: opts.messageId, timestamp: opts.timestamp, sessionId: opts.sessionId, correlationId: opts.correlationId, payload: command }); }
export interface TlsServerConfigV1 { enabled: boolean; minVersion: "1.2" | "1.3"; certRef?: string; keyRef?: string; }
export interface EndpointAuthConfigV1 { scheme: AuthSchemeV1; }
export interface TransportEndpointConfigV1 { kind: EndpointKindV1; host?: string; port?: number; auth?: EndpointAuthConfigV1; tls?: TlsServerConfigV1; allowRemote: boolean; }
export interface EndpointSecurityVerdictV1 { kind: EndpointKindV1; loopback: boolean; authScheme: AuthSchemeV1; tlsEnabled: boolean; allowRemote: boolean; }
export function isLoopbackHostV1(host: string): boolean { const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true; if (!/^127\.\d{1,3}(\.\d{1,3}){2}$/.test(normalized)) return false; return normalized.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255); }
export function transportFramingV1(kind: EndpointKindV1): FramingKindV1 { return kind === "stdio" ? "jsonl" : kind === "tcp" ? "length_prefixed" : "frame"; }
export function validateTlsServerConfigV1(tls: TlsServerConfigV1 | undefined): ResultValue<null, ProtocolErrorV1> { if (tls === undefined || tls.enabled === false) return Result.ok(null); if (tls.minVersion !== "1.2" && tls.minVersion !== "1.3") return Result.err(new ProtocolErrorV1("transport_tls_invalid_config", "TLS minimum version is invalid")); if (!tls.certRef || !tls.keyRef) return Result.err(new ProtocolErrorV1("transport_tls_invalid_config", "enabled TLS requires credential references")); return Result.ok(null); }
export function validateEndpointSecurityV1(config: TransportEndpointConfigV1): ResultValue<EndpointSecurityVerdictV1, ProtocolErrorV1> {
	if (!["stdio", "tcp", "websocket"].includes(config.kind)) return Result.err(new ProtocolErrorV1("transport_invalid_endpoint", "endpoint kind is invalid")); const tls = validateTlsServerConfigV1(config.tls); if (!tls.ok) return tls;
	if (config.kind === "stdio") return Result.ok({ kind: config.kind, loopback: true, authScheme: config.auth?.scheme ?? "none", tlsEnabled: config.tls?.enabled ?? false, allowRemote: config.allowRemote });
	const loopback = isLoopbackHostV1(config.host ?? "127.0.0.1"); if (loopback) return Result.ok({ kind: config.kind, loopback, authScheme: config.auth?.scheme ?? "none", tlsEnabled: config.tls?.enabled ?? false, allowRemote: config.allowRemote });
	if ((config.auth?.scheme ?? "none") === "none") return Result.err(new ProtocolErrorV1("transport_requires_auth", "non-loopback endpoint requires authentication")); if (config.tls?.enabled !== true) return Result.err(new ProtocolErrorV1("transport_requires_tls", "non-loopback endpoint requires TLS")); if (!config.allowRemote) return Result.err(new ProtocolErrorV1("transport_requires_allow_remote", "remote endpoint requires explicit allowRemote"));
	return Result.ok({ kind: config.kind, loopback: false, authScheme: config.auth!.scheme, tlsEnabled: true, allowRemote: true });
}
export interface AuthProofV1 { bearerTokenProvided?: boolean; clientCertificatePresent?: boolean; }
export function authenticateConnectionV1(config: TransportEndpointConfigV1, proof: AuthProofV1): ResultValue<null, ProtocolErrorV1> { const scheme = config.auth?.scheme ?? "none"; if (scheme === "none") return Result.ok(null); if (scheme === "bearer" && proof.bearerTokenProvided === true) return Result.ok(null); if (scheme === "mtls" && proof.clientCertificatePresent === true) return Result.ok(null); return Result.err(new ProtocolErrorV1("transport_not_authorized", "connection authentication proof is missing")); }
