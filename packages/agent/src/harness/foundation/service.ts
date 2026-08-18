import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ServiceLifecycleV1 = "managed" | "ephemeral" | "external";
export interface ServiceContractV1 { schemaVersion: 1; serviceId: string; revision: number; version: string; providerId: string; consumers: readonly string[]; lifecycle: ServiceLifecycleV1; capabilities: readonly string[]; dependencies: readonly string[]; endpointRef?: string; configProfileId?: string; createdAt: string; }
export const ServiceContractV1Schema = Type.Object({ schemaVersion: Type.Literal(1), serviceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), version: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), consumers: Type.Array(Type.String({ minLength: 1 })), lifecycle: Type.Union([Type.Literal("managed"), Type.Literal("ephemeral"), Type.Literal("external")]), capabilities: Type.Array(Type.String({ minLength: 1 })), dependencies: Type.Array(Type.String({ minLength: 1 })), endpointRef: Type.Optional(Type.String({ minLength: 1 })), configProfileId: Type.Optional(Type.String({ minLength: 1 })), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateServiceContractV1(value: unknown): ResultValue<ServiceContractV1, FoundationError> { return validateExactShape<ServiceContractV1>(ServiceContractV1Schema, value, "service_contract"); }
export function serializeServiceContractV1(value: ServiceContractV1): string { return serializeExactShape(ServiceContractV1Schema, value, "service_contract"); }
export function parseServiceContractV1(text: string): ResultValue<ServiceContractV1, FoundationError> { return parseExactShape(ServiceContractV1Schema, text, "service_contract"); }
export function validateServiceDependenciesV1(services: readonly ServiceContractV1[]): ResultValue<readonly ServiceContractV1[], FoundationError> {
	const ids = new Set(services.map((service) => service.serviceId)); const visiting = new Set<string>(); const visited = new Set<string>();
	const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; const service = services.find((candidate) => candidate.serviceId === id); if (!service) return false; visiting.add(id); for (const dependency of service.dependencies) if (!visit(dependency)) return false; visiting.delete(id); visited.add(id); return true; };
	for (const service of services) if (!ids.has(service.serviceId) || !visit(service.serviceId)) return Result.err(new FoundationError("service_cycle", "service dependency graph is invalid"));
	return Result.ok(services);
}
