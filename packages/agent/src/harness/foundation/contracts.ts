import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import { ObserverCursorSchema, type ObserverCursor } from "./observer.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface ProviderContract { schemaVersion: 1; providerId: string; kind: "model" | "tool" | "sandbox" | "operation" | "external"; capabilities: { retryable: boolean; cancellable: boolean; heartbeat: boolean; budget: boolean }; features: readonly string[]; }
export const ProviderContractSchema = Type.Object({ schemaVersion: Type.Literal(1), providerId: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("model"), Type.Literal("tool"), Type.Literal("sandbox"), Type.Literal("operation"), Type.Literal("external")]), capabilities: Type.Object({ retryable: Type.Boolean(), cancellable: Type.Boolean(), heartbeat: Type.Boolean(), budget: Type.Boolean() }, { additionalProperties: false }), features: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface GatewayContract { schemaVersion: 1; gatewayId: string; routes: readonly string[]; providers: readonly string[]; }
export const GatewayContractSchema = Type.Object({ schemaVersion: Type.Literal(1), gatewayId: Type.String({ minLength: 1 }), routes: Type.Array(Type.String({ minLength: 1 })), providers: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export interface ObserverContract { schemaVersion: 1; observerId: string; subscriptions: readonly string[]; cursor?: ObserverCursor; }
export const ObserverContractSchema = Type.Object({ schemaVersion: Type.Literal(1), observerId: Type.String({ minLength: 1 }), subscriptions: Type.Array(Type.String({ minLength: 1 })), cursor: Type.Optional(ObserverCursorSchema) }, { additionalProperties: false });
export interface TransportContract { schemaVersion: 1; transportId: string; kind: "in-process" | "stream" | "rpc"; serialization: "json" | "jsonl" | "binary"; }
export const TransportContractSchema = Type.Object({ schemaVersion: Type.Literal(1), transportId: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("in-process"), Type.Literal("stream"), Type.Literal("rpc")]), serialization: Type.Union([Type.Literal("json"), Type.Literal("jsonl"), Type.Literal("binary")]) }, { additionalProperties: false });
export interface QuotaContract { schemaVersion: 1; quotaId: string; scope: "run" | "session" | "worker" | "namespace"; limits: Readonly<Record<string, number>>; }
export const QuotaContractSchema = Type.Object({ schemaVersion: Type.Literal(1), quotaId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("run"), Type.Literal("session"), Type.Literal("worker"), Type.Literal("namespace")]), limits: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0 })) }, { additionalProperties: false });
function validate<T>(schema: Parameters<typeof validateExactShape>[0], value: unknown, kind: string): ResultValue<T, FoundationError> { return validateExactShape<T>(schema, value, kind); }
export function validateProviderContract(value: unknown): ResultValue<ProviderContract, FoundationError> { return validate(ProviderContractSchema, value, "provider_contract"); }
export function serializeProviderContract(value: ProviderContract): string { return serializeExactShape(ProviderContractSchema, value, "provider_contract"); }
export function parseProviderContract(text: string): ResultValue<ProviderContract, FoundationError> { return parseExactShape(ProviderContractSchema, text, "provider_contract"); }
export function validateGatewayContract(value: unknown): ResultValue<GatewayContract, FoundationError> { return validate(GatewayContractSchema, value, "gateway_contract"); }
export function serializeGatewayContract(value: GatewayContract): string { return serializeExactShape(GatewayContractSchema, value, "gateway_contract"); }
export function parseGatewayContract(text: string): ResultValue<GatewayContract, FoundationError> { return parseExactShape(GatewayContractSchema, text, "gateway_contract"); }
export function validateObserverContract(value: unknown): ResultValue<ObserverContract, FoundationError> { return validate(ObserverContractSchema, value, "observer_contract"); }
export function serializeObserverContract(value: ObserverContract): string { return serializeExactShape(ObserverContractSchema, value, "observer_contract"); }
export function parseObserverContract(text: string): ResultValue<ObserverContract, FoundationError> { return parseExactShape(ObserverContractSchema, text, "observer_contract"); }
export function validateTransportContract(value: unknown): ResultValue<TransportContract, FoundationError> { return validate(TransportContractSchema, value, "transport_contract"); }
export function serializeTransportContract(value: TransportContract): string { return serializeExactShape(TransportContractSchema, value, "transport_contract"); }
export function parseTransportContract(text: string): ResultValue<TransportContract, FoundationError> { return parseExactShape(TransportContractSchema, text, "transport_contract"); }
export function validateQuotaContract(value: unknown): ResultValue<QuotaContract, FoundationError> { return validate(QuotaContractSchema, value, "quota_contract"); }
export function serializeQuotaContract(value: QuotaContract): string { return serializeExactShape(QuotaContractSchema, value, "quota_contract"); }
export function parseQuotaContract(text: string): ResultValue<QuotaContract, FoundationError> { return parseExactShape(QuotaContractSchema, text, "quota_contract"); }
