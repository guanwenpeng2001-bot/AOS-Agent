import { Type } from "typebox";
import { Result, type ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ServiceLifecycle = "managed" | "ephemeral" | "external";
export interface ServiceContract { schemaVersion: 1; serviceId: string; revision: number; version: string; providerId: string; consumers: readonly string[]; lifecycle: ServiceLifecycle; capabilities: readonly string[]; dependencies: readonly string[]; endpointRef?: string; configProfileId?: string; createdAt: string; }
export const ServiceContractSchema = Type.Object({ schemaVersion: Type.Literal(1), serviceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), version: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), consumers: Type.Array(Type.String({ minLength: 1 })), lifecycle: Type.Union([Type.Literal("managed"), Type.Literal("ephemeral"), Type.Literal("external")]), capabilities: Type.Array(Type.String({ minLength: 1 })), dependencies: Type.Array(Type.String({ minLength: 1 })), endpointRef: Type.Optional(Type.String({ minLength: 1 })), configProfileId: Type.Optional(Type.String({ minLength: 1 })), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateServiceContract(value: unknown): ResultValue<ServiceContract, FoundationError> { return validateExactShape<ServiceContract>(ServiceContractSchema, value, "service_contract"); }
export function serializeServiceContract(value: ServiceContract): string { return serializeExactShape(ServiceContractSchema, value, "service_contract"); }
export function parseServiceContract(text: string): ResultValue<ServiceContract, FoundationError> { return parseExactShape(ServiceContractSchema, text, "service_contract"); }
export function validateServiceDependencies(services: readonly ServiceContract[]): ResultValue<readonly ServiceContract[], FoundationError> {
	const ids = new Set(services.map((service) => service.serviceId)); const visiting = new Set<string>(); const visited = new Set<string>();
	const visit = (id: string): boolean => { if (visiting.has(id)) return false; if (visited.has(id)) return true; const service = services.find((candidate) => candidate.serviceId === id); if (!service) return false; visiting.add(id); for (const dependency of service.dependencies) if (!visit(dependency)) return false; visiting.delete(id); visited.add(id); return true; };
	for (const service of services) if (!ids.has(service.serviceId) || !visit(service.serviceId)) return Result.err(new FoundationError("service_cycle", "service dependency graph is invalid"));
	return Result.ok(services);
}
