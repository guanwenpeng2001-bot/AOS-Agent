import type { ImageContent, TextContent } from "@aos-agent/ai";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import type { CapabilityRegistry } from "./policy/capability-registry.ts";
import { type MCPCallResult, MCPError, mcpNamespaceSegmentError } from "./mcp-types.ts";

/**
 * Identity inputs for a discovered MCP tool, supplied by the settings layer.
 *
 * The source identity and the parent `mcp_server` descriptor id are NOT
 * hardcoded here: the caller decides how the mcp_server descriptor was keyed
 * (for example `mcp_server:mcp:global:docs` for a global-scope server "docs"),
 * so the mcp_tool descriptor id is derived from the same source identity.
 */
export interface MCPToolMappingOptions {
	/** Logical MCP server id; must be a valid namespace segment. */
	serverId: string;
	/** Source identity of this server's mcp_tool capabilities (e.g. "mcp:global:docs"). */
	sourceIdentity: string;
	/** Capability id of the parent `mcp_server` descriptor. */
	parentDescriptorId: string;
	/**
	 * Registry whose installation identity derives this tool's public descriptor
	 * id. Every caller must provide the Registry active for the containing
	 * session so the descriptor and its parent share one identity.
	 */
	registry: CapabilityRegistry;
}

/**
 * Invokes a discovered tool on the server. Typically wired to
 * {@link MCPLifecycleManager.callTool}.
 */
export interface MCPToolAdapterOptions extends MCPToolMappingOptions {
	callTool: (
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<MCPCallResult>;
}

/** Stable, secret-free identity of a discovered MCP tool. */
export interface MCPToolMapping {
	serverId: string;
	sourceIdentity: string;
	/** Raw server tool definition. */
	tool: Tool;
	/** Server-local tool name. */
	toolName: string;
	/** Model-visible name: `mcp__<serverId>__<toolName>`. */
	exposedToolName: string;
	/** Parent `mcp_server` capability descriptor id (from the settings layer). */
	parentDescriptorId: string;
	/** This tool's capability descriptor id. */
	descriptorId: string;
	/** Secret-free input for the capability revision fingerprint. */
	revisionInput: unknown;
}

/** A namespaced ToolDefinition together with the tool's capability identity. */
export interface MCPToolDefinitionResult {
	mapping: MCPToolMapping;
	definition: ToolDefinition<TSchema, MCPCallResult>;
}

/**
 * Computes the stable identity for a discovered MCP tool.
 *
 * Rejects empty or double-underscore namespace segments (and whitespace or
 * colons, which would make `mcp__server__tool` names or descriptor ids
 * ambiguous) so a namespaced name can never be silently misparsed.
 */
export function createMCPToolMapping(
	tool: Tool,
	options: MCPToolMappingOptions,
): MCPToolMapping {
	const serverError = mcpNamespaceSegmentError(options.serverId);
	if (serverError !== undefined) {
		throw new MCPError("invalid_config", options.serverId, `MCP server id ${serverError}`);
	}
	const toolName = tool.name;
	const toolError = mcpNamespaceSegmentError(toolName);
	if (toolError !== undefined) {
		throw new MCPError("invalid_config", options.serverId, `MCP tool name "${toolName}" ${toolError}`);
	}
	return {
		serverId: options.serverId,
		sourceIdentity: options.sourceIdentity,
		tool,
		toolName,
		exposedToolName: `mcp__${options.serverId}__${toolName}`,
		parentDescriptorId: options.parentDescriptorId,
		descriptorId: options.registry.createCapabilityId("mcp_tool", options.sourceIdentity, toolName),
		revisionInput: {
			name: toolName,
			description: tool.description,
			inputSchema: tool.inputSchema,
		},
	};
}

/**
 * Maps a discovered MCP tool to a namespaced ToolDefinition.
 *
 * The exposed name always carries the `mcp__<serverId>__<toolName>` prefix, so
 * MCP tools can never collide with builtin, extension, or SDK tools. Tool calls
 * route through {@link MCPToolAdapterOptions.callTool}. A server-reported
 * failure (`isError`) throws a redacted {@link MCPError} of kind `call_failed`
 * whose message and JSON never contain remote content or text.
 */
export function createMCPToolDefinition(
	tool: Tool,
	options: MCPToolAdapterOptions,
): MCPToolDefinitionResult {
	const mapping = createMCPToolMapping(tool, options);
	const definition: ToolDefinition<TSchema, MCPCallResult> = {
		name: mapping.exposedToolName,
		label: tool.title ?? tool.name,
		description: tool.description ?? "",
		// Preserve the server's JSON Schema for parameter validation.
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as unknown as TSchema),
		execute: async (toolCallId, params, signal) => {
			const result = await options.callTool(mapping.toolName, params as Record<string, unknown>, signal);
			if (result.isError) {
				throw new MCPError(
					"call_failed",
					options.serverId,
					`MCP server "${options.serverId}" failed to execute tool call "${mapping.toolName}"`,
				);
			}
			return {
				content: toAgentContent(result),
				details: result,
			};
		},
	};
	return { mapping, definition };
}

/** Maps every discovered tool for a server into namespaced definitions. */
export function mapMCPToolsToDefinitions(
	tools: ReadonlyArray<Tool>,
	options: MCPToolAdapterOptions,
): MCPToolDefinitionResult[] {
	const results = tools.map((tool) => createMCPToolDefinition(tool, options));
	const byExposedName = new Map<string, string>();
	for (const result of results) {
		const previous = byExposedName.get(result.mapping.exposedToolName);
		if (previous !== undefined) {
			throw new MCPError(
				"invalid_config",
				options.serverId,
				`Duplicate MCP tool exposed name "${result.mapping.exposedToolName}" (from "${previous}" and "${result.mapping.toolName}")`,
			);
		}
		byExposedName.set(result.mapping.exposedToolName, result.mapping.toolName);
	}
	return results;
}

/**
 * Returns true only for valid MCP namespaced tool names
 * (`mcp__<serverId>__<toolName>` with non-empty, single-underscore segments).
 */
export function isMCPExposedToolName(name: string): boolean {
	const match = /^mcp__(.+?)(?:__)(.+)$/.exec(name);
	if (match === null) {
		return false;
	}
	return isValidSegment(match[1]) && isValidSegment(match[2]);
}

function isValidSegment(segment: string): boolean {
	return mcpNamespaceSegmentError(segment) === undefined;
}

/**
 * Filters a mixed list of model-visible tool names down to the MCP-namespaced
 * subset. Used when a binding exposes both builtin tools and MCP tools so the
 * MCP-only names can be isolated without guessing by server.
 */
export function filterMCPExposedToolNames(names: ReadonlyArray<string>): string[] {
	return names.filter((name) => isMCPExposedToolName(name));
}

function toAgentContent(result: MCPCallResult): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "image":
				out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource":
				if (block.resource.text !== undefined) {
					out.push({ type: "text", text: block.resource.text });
				} else if (
					block.resource.blob !== undefined &&
					(block.resource.mimeType ?? "").startsWith("image/")
				) {
					out.push({
						type: "image",
						data: block.resource.blob,
						mimeType: block.resource.mimeType ?? "image/png",
					});
				}
				break;
			case "audio":
				// Audio content is not representable in AgentToolResult; omitted.
				break;
		}
	}
	if (out.length === 0 && result.structuredContent !== undefined) {
		out.push({ type: "text", text: JSON.stringify(result.structuredContent) });
	}
	return out;
}
