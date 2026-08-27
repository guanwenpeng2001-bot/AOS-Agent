import type {
	ToolGatewayRequest,
	ToolGatewayRoute,
} from "@aos-agent/agent-core";
import { PolicyError, type PolicyOperationRequest } from "./execution-policy.ts";
import {
	assertPathInsideWorkspace,
	resolveHostPathForPolicy,
	type HostFilesystemRoots,
} from "./policy-filesystem.ts";
import type { PolicyEffect } from "./protected-path-policy.ts";

export interface ExternalToolPolicyOperationInput {
	readonly request: ToolGatewayRequest;
	readonly route: ToolGatewayRoute;
	readonly cwd: string;
	readonly roots: HostFilesystemRoots;
	readonly capabilityId?: string;
}

const RAW_COMMAND_EFFECTS = Object.freeze([
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
] satisfies readonly PolicyEffect[]);

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

function routeIdentity(route: ToolGatewayRoute): string {
	const toolName = route.toolName.toLowerCase();
	const namespace = route.namespace?.toLowerCase();
	if (namespace === undefined || toolName.startsWith(`${namespace}.`)) return toolName;
	return `${namespace}.${toolName}`;
}

function routeLeaf(route: ToolGatewayRoute): string {
	const identity = routeIdentity(route);
	const separator = identity.lastIndexOf(".");
	return separator === -1 ? identity : identity.slice(separator + 1);
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
	const args = record(input.request.originalArguments);
	const identity = routeIdentity(input.route);
	const leaf = routeLeaf(input.route);
	const base = common(input);

	if (["read", "find", "grep", "search"].includes(leaf)) {
		const targetPath = stringArgument(args, "path", "cwd", "directory") ?? ".";
		const resolved = await canonicalPath(input, targetPath, "read");
		return {
			...base,
			resource: leaf === "find" || leaf === "search"
				? "filesystem.find"
				: leaf === "grep"
					? "filesystem.grep"
					: "filesystem.read",
			scope: "workspace",
			path: targetPath,
			effects: ["read"],
			canonicalPath: resolved.canonicalPath!,
		};
	}

	if (["write", "create", "edit", "patch"].includes(leaf)) {
		const targetPath = requiredStringArgument(args, "path", "file", "targetPath");
		const resolved = await canonicalPath(input, targetPath, "write");
		const effects: readonly PolicyEffect[] = leaf === "create" || !resolved.existingPath ? ["create"] : ["write"];
		return {
			...base,
			resource: "filesystem.write",
			scope: "workspace",
			path: targetPath,
			effects,
			canonicalPath: resolved.canonicalPath!,
		};
	}

	if (["delete", "remove", "unlink"].includes(leaf)) {
		const targetPath = requiredStringArgument(args, "path", "file", "targetPath");
		const resolved = await canonicalPath(input, targetPath, "write");
		return {
			...base,
			resource: "filesystem.write",
			scope: "workspace",
			path: targetPath,
			effects: ["delete"],
			canonicalPath: resolved.canonicalPath!,
		};
	}

	if (["move", "rename"].includes(leaf)) {
		const sourcePath = requiredStringArgument(args, "path", "sourcePath", "from");
		const targetPath = requiredStringArgument(args, "targetPath", "destinationPath", "to");
		const [source, target] = await Promise.all([
			canonicalPath(input, sourcePath, "write"),
			canonicalPath(input, targetPath, "write"),
		]);
		return {
			...base,
			resource: "filesystem.write",
			scope: "workspace",
			path: sourcePath,
			targetPath,
			effects: ["move"],
			canonicalPaths: [source.canonicalPath!, target.canonicalPath!],
		};
	}

	if (["bash", "shell", "command", "exec", "run", "spawn"].includes(leaf)) {
		const workspace = await canonicalPath(input, ".", "read");
		return {
			...base,
			resource: "process.spawn",
			scope: "workspace",
			command: stringArgument(args, "command", "cmd") ?? identity,
			effects: RAW_COMMAND_EFFECTS,
			canonicalPath: workspace.canonicalPath!,
			requiresSandbox: true,
			sandboxed: input.route.kind === "sandbox",
			...(input.route.kind === "sandbox" ? { sandboxProviderId: input.route.providerId } : {}),
		};
	}

	if (identity.startsWith("git.") || input.route.namespace?.toLowerCase() === "git") {
		const workspace = await canonicalPath(input, ".", "read");
		if (["status", "diff", "show", "log", "blame"].includes(leaf)) {
			return { ...base, resource: "filesystem.read", scope: "workspace", effects: ["read"], canonicalPath: workspace.canonicalPath! };
		}
		if (leaf === "commit") {
			return { ...base, resource: "process.spawn", scope: "workspace", effects: ["write", "commit"], canonicalPath: workspace.canonicalPath! };
		}
		if (leaf === "push") {
			return { ...base, resource: "network.connect", scope: "workspace", effects: ["network", "push"], canonicalPath: workspace.canonicalPath! };
		}
		if (leaf === "merge") {
			return { ...base, resource: "process.spawn", scope: "workspace", effects: ["write", "merge"], canonicalPath: workspace.canonicalPath! };
		}
		return { ...base, resource: "process.spawn", scope: "workspace", effects: ["write"], canonicalPath: workspace.canonicalPath! };
	}

	if (["connect", "request", "fetch", "download", "upload"].includes(leaf) || identity.startsWith("network.")) {
		return {
			...base,
			resource: "network.connect",
			effects: ["network"],
			...(stringArgument(args, "destination", "url", "host") === undefined
				? {}
				: { destination: stringArgument(args, "destination", "url", "host") }),
		};
	}

	return { ...base, resource: "capability.invoke" };
}
