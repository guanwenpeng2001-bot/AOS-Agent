import {
	isToolGatewayRoute,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
import { PolicyError, type PolicyOperationRequest } from "./execution-policy.ts";
import {
	assertPathInsideWorkspace,
	resolveHostPathForPolicy,
	type HostFilesystemRoots,
} from "./policy-filesystem.ts";

export interface ExternalToolPolicyOperationInput {
	readonly request: ToolGatewayRequest;
	readonly route: ToolGatewayRoute;
	readonly cwd: string;
	readonly roots: HostFilesystemRoots;
	readonly capabilityId?: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function stringArgument(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function requiredStringArgument(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string {
	const value = stringArgument(args, ...keys);
	if (value === undefined) throw new PolicyError("protected_path_invalid");
	return value;
}

async function canonicalPath(input: ExternalToolPolicyOperationInput, targetPath: string, access: "read" | "write") {
	const resolved = await resolveHostPathForPolicy({
		cwd: input.cwd,
		targetPath,
		roots: input.roots,
		access,
	});
	assertPathInsideWorkspace(resolved);
	return resolved;
}

function common(input: ExternalToolPolicyOperationInput) {
	return {
		source: input.route.kind === "mcp" ? "mcp" as const : "rpc" as const,
		id: input.request.toolCallId,
		...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }),
	};
}

/**
 * Classify one exact Tool Gateway route without inspecting command text.
 * Filesystem paths cross the canonical host containment boundary before they
 * enter Policy. Raw commands carry every potentially mutating effect and can
 * execute only through a ready sandbox route.
 */
export async function classifyExternalToolPolicyOperation(
	input: ExternalToolPolicyOperationInput,
): Promise<PolicyOperationRequest> {
	if (
		!isToolGatewayRoute(input.route) ||
		input.request.toolName !== input.route.toolName ||
		input.request.namespace !== input.route.namespace
	) throw new PolicyError("protected_path_invalid");
	const args = record(input.request.originalArguments);
	const base = common(input);
	const operation = input.route.operation;

	if (["filesystem.read", "filesystem.find", "filesystem.grep"].includes(operation.resource)) {
		const targetPath = stringArgument(args, "path", "cwd", "directory") ?? ".";
		const resolved = await canonicalPath(input, targetPath, "read");
		return {
			...base,
			resource: operation.resource,
			scope: "workspace",
			path: targetPath,
			effects: operation.effects,
			canonicalPath: resolved.canonicalPath!,
		};
	}

	if (operation.resource === "filesystem.write") {
		const targetPath = requiredStringArgument(args, "path", "file", "targetPath");
		if (operation.effects.includes("move")) {
			const destinationPath = requiredStringArgument(args, "targetPath", "destinationPath", "to");
			const [source, target] = await Promise.all([
				canonicalPath(input, targetPath, "write"),
				canonicalPath(input, destinationPath, "write"),
			]);
			return {
				...base,
				resource: operation.resource,
				scope: "workspace",
				path: targetPath,
				targetPath: destinationPath,
				effects: operation.effects,
				canonicalPaths: [source.canonicalPath!, target.canonicalPath!],
			};
		}
		const resolved = await canonicalPath(input, targetPath, "write");
		return { ...base, resource: operation.resource, scope: "workspace", path: targetPath, effects: operation.effects, canonicalPath: resolved.canonicalPath! };
	}

	if (operation.resource === "process.spawn") {
		const workspace = await canonicalPath(input, ".", "read");
		return {
			...base,
			resource: operation.resource,
			scope: "workspace",
			command: stringArgument(args, "command", "cmd") ?? input.route.toolName,
			effects: operation.effects,
			canonicalPath: workspace.canonicalPath!,
			requiresSandbox: operation.requiresSandbox === true,
			sandboxed: input.route.kind === "sandbox",
			...(input.route.kind === "sandbox" ? { sandboxProviderId: input.route.providerId } : {}),
		};
	}

	if (operation.resource === "network.connect") {
		const destination = stringArgument(args, "destination", "url", "host");
		return {
			...base,
			resource: operation.resource,
			effects: operation.effects,
			...(destination === undefined ? {} : { destination }),
		};
	}

	throw new PolicyError("protected_path_invalid");
}
