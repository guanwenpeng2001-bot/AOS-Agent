import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import { ObserverCursorV1Schema, type ObserverCursorV1 } from "./observer.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface ProviderContractV1 { schemaVersion: 1; providerId: string; kind: "model" | "tool" | "sandbox" | "operation" | "external"; capabilities: { retryable: boolean; cancellable: boolean; heartbeat: boolean; budget: boolean }; features: readonly string[]; }
export const ProviderContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), providerId: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("model"), Type.Literal("tool"), Type.Literal("sandbox"), Type.Literal("operation"), Type.Literal("external")]), capabilities: Type.Object({ retryable: Type.Boolean(), cancellable: Type.Boolean(), heartbeat: Type.Boolean(), budget: Type.Boolean() }, { additionalProperties: false }), features: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface GatewayContractV1 { schemaVersion: 1; gatewayId: string; routes: readonly string[]; providers: readonly string[]; }
export const GatewayContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), gatewayId: Type.String({ minLength: 1 }), routes: Type.Array(Type.String({ minLength: 1 })), providers: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface ObserverContractV1 { schemaVersion: 1; observerId: string; subscriptions: readonly string[]; cursor?: ObserverCursorV1; }
export const ObserverContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), observerId: Type.String({ minLength: 1 }), subscriptions: Type.Array(Type.String({ minLength: 1 })), cursor: Type.Optional(ObserverCursorV1Schema) }, { additionalProperties: false });
export interface TransportContractV1 { schemaVersion: 1; transportId: string; kind: "in-process" | "stream" | "rpc"; serialization: "json" | "jsonl" | "binary"; }
export const TransportContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), transportId: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("in-process"), Type.Literal("stream"), Type.Literal("rpc")]), serialization: Type.Union([Type.Literal("json"), Type.Literal("jsonl"), Type.Literal("binary")]) }, { additionalProperties: false });
export interface QuotaContractV1 { schemaVersion: 1; quotaId: string; scope: "run" | "session" | "worker" | "namespace"; limits: Readonly<Record<string, number>>; }
export const QuotaContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), quotaId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("run"), Type.Literal("session"), Type.Literal("worker"), Type.Literal("namespace")]), limits: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0 })) }, { additionalProperties: false });
function validate<T>(schema: Parameters<typeof validateExactShape>[0], value: unknown, kind: string): ResultValue<T, FoundationError> { return validateExactShape<T>(schema, value, kind); }
export function validateProviderContractV1(value: unknown): ResultValue<ProviderContractV1, FoundationError> { return validate(ProviderContractV1Schema, value, "provider_contract"); }
export function serializeProviderContractV1(value: ProviderContractV1): string { return serializeExactShape(ProviderContractV1Schema, value, "provider_contract"); }
export function parseProviderContractV1(text: string): ResultValue<ProviderContractV1, FoundationError> { return parseExactShape(ProviderContractV1Schema, text, "provider_contract"); }
export function validateGatewayContractV1(value: unknown): ResultValue<GatewayContractV1, FoundationError> { return validate(GatewayContractV1Schema, value, "gateway_contract"); }
export function serializeGatewayContractV1(value: GatewayContractV1): string { return serializeExactShape(GatewayContractV1Schema, value, "gateway_contract"); }
export function parseGatewayContractV1(text: string): ResultValue<GatewayContractV1, FoundationError> { return parseExactShape(GatewayContractV1Schema, text, "gateway_contract"); }
export function validateObserverContractV1(value: unknown): ResultValue<ObserverContractV1, FoundationError> { return validate(ObserverContractV1Schema, value, "observer_contract"); }
export function serializeObserverContractV1(value: ObserverContractV1): string { return serializeExactShape(ObserverContractV1Schema, value, "observer_contract"); }
export function parseObserverContractV1(text: string): ResultValue<ObserverContractV1, FoundationError> { return parseExactShape(ObserverContractV1Schema, text, "observer_contract"); }
export function validateTransportContractV1(value: unknown): ResultValue<TransportContractV1, FoundationError> { return validate(TransportContractV1Schema, value, "transport_contract"); }
export function serializeTransportContractV1(value: TransportContractV1): string { return serializeExactShape(TransportContractV1Schema, value, "transport_contract"); }
export function parseTransportContractV1(text: string): ResultValue<TransportContractV1, FoundationError> { return parseExactShape(TransportContractV1Schema, text, "transport_contract"); }
export function validateQuotaContractV1(value: unknown): ResultValue<QuotaContractV1, FoundationError> { return validate(QuotaContractV1Schema, value, "quota_contract"); }
export function serializeQuotaContractV1(value: QuotaContractV1): string { return serializeExactShape(QuotaContractV1Schema, value, "quota_contract"); }
export function parseQuotaContractV1(text: string): ResultValue<QuotaContractV1, FoundationError> { return parseExactShape(QuotaContractV1Schema, text, "quota_contract"); }
