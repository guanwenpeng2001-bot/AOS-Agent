/**
 * Trusted, private Claude Agent SDK companion entry.
 *
 * This is the only coding-agent module that imports the optional vendor SDK.
 * It is intentionally absent from the package export map and default root.
 */

import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import type {
	HookCallback,
	McpServerConfig,
	Options,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { canonicalFoundationJson, type FoundationJsonValue } from "@aos-agent/agent-core";
import { createJiti } from "jiti";
import { z } from "zod/v4";
import {
	PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	type PrivateClaudeAgentSdkCompanion,
	type PrivateClaudeCompanionQueryRequest,
	type PrivateClaudeNativeContentBlock,
	type PrivateClaudeSelectedTool,
} from "../core/connector/vendor/claude.ts";

function asFoundationJson(value: unknown): FoundationJsonValue {
	return JSON.parse(canonicalFoundationJson(value)) as FoundationJsonValue;
}

function observationHook(
	request: PrivateClaudeCompanionQueryRequest,
	eventName: "PreToolUse" | "PostToolUse" | "PostToolUseFailure",
): HookCallback {
	return async (_input, toolUseId) => {
		try {
			request.observeHook(eventName, toolUseId);
		} catch {
			// Observation cannot grant, deny, rewrite, or interrupt a tool call.
		}
		return {};
	};
}

function sdkTool(
	request: PrivateClaudeCompanionQueryRequest,
	selected: PrivateClaudeSelectedTool,
	sdk: typeof ClaudeAgentSdk,
) {
	return sdk.tool(
		selected.toolName,
		"Execute the exact host-selected AOS Tool Gateway route.",
		{ input: z.record(z.string(), z.unknown()) },
		async ({ input }) => {
			const result = await request.executeTool({
				toolUseId: crypto.randomUUID(),
				toolName: selected.exposedToolName,
				input: asFoundationJson(input),
				signal: request.abortController.signal,
			});
			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Tool Gateway denied the request." }],
				};
			}
			return {
				content: [{
					type: "text" as const,
					text: result.result === undefined ? "null" : canonicalFoundationJson(result.result),
				}],
			};
		},
	);
}

function mcpServers(
	request: PrivateClaudeCompanionQueryRequest,
	sdk: typeof ClaudeAgentSdk,
): Record<string, McpServerConfig> {
	const grouped = new Map<string, PrivateClaudeSelectedTool[]>();
	for (const selected of request.tools) {
		const tools = grouped.get(selected.serverName) ?? [];
		tools.push(selected);
		grouped.set(selected.serverName, tools);
	}
	return Object.fromEntries([...grouped.entries()].map(([serverName, tools]) => [
		serverName,
		sdk.createSdkMcpServer({
			name: serverName,
			version: "1",
			alwaysLoad: true,
			tools: tools.map((selected) => sdkTool(request, selected, sdk)),
		}),
	]));
}

function nativeContentBlock(block: PrivateClaudeNativeContentBlock): ContentBlockParam {
	if (block.type === "text") return { type: "text", text: block.text };
	if (block.type === "image") return { type: "image", source: { ...block.source } };
	return { type: "document", source: { ...block.source } };
}

function promptFor(request: PrivateClaudeCompanionQueryRequest): AsyncIterable<SDKUserMessage> {
	return {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "user",
				message: {
					role: "user",
					content: request.prompt.content.map(nativeContentBlock),
				},
				parent_tool_use_id: null,
			};
		},
	};
}

function environmentFor(request: PrivateClaudeCompanionQueryRequest): Record<string, string> {
	if (request.model === undefined) return { ...request.env };
	if (request.modelGateway === undefined) throw new TypeError("Claude gateway model capability is missing");
	const gatewayOrigin = new URL(request.modelGateway.endpoint).origin;
	return {
		...request.env,
		CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
		CLAUDE_CODE_USE_ANTHROPIC_AWS: "0",
		CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "0",
		CLAUDE_CODE_USE_BEDROCK: "0",
		CLAUDE_CODE_USE_FOUNDRY: "0",
		CLAUDE_CODE_USE_GATEWAY: "1",
		CLAUDE_CODE_USE_MANTLE: "0",
		CLAUDE_CODE_USE_VERTEX: "0",
		ANTHROPIC_BASE_URL: gatewayOrigin,
		ANTHROPIC_AUTH_TOKEN: request.modelGateway.authorization.replace(/^Bearer /, ""),
	};
}

function optionsFor(
	request: PrivateClaudeCompanionQueryRequest,
	executablePath: string | undefined,
	sdk: typeof ClaudeAgentSdk,
): Options {
	const selectedNames = new Set(request.tools.map((selected) => selected.exposedToolName));
	const spawnClaudeCodeProcess = request.spawnClaudeCodeProcess;
	return {
		abortController: request.abortController,
		allowedTools: [],
		agents: {},
		cwd: request.cwd,
		env: {
			...environmentFor(request),
			CLAUDE_AGENT_SDK_CLIENT_APP: "aos-agent/0.84.3",
		},
		...(request.model === undefined ? {} : { model: request.model.model, effort: request.model.effort }),
		hooks: {
			PreToolUse: [{ hooks: [observationHook(request, "PreToolUse")] }],
			PostToolUse: [{ hooks: [observationHook(request, "PostToolUse")] }],
			PostToolUseFailure: [{ hooks: [observationHook(request, "PostToolUseFailure")] }],
		},
		mcpServers: mcpServers(request, sdk),
		permissionMode: "default",
		plugins: [],
		...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
		settingSources: [],
		skills: [],
		strictMcpConfig: true,
		tools: [],
		...(spawnClaudeCodeProcess === undefined
			? {}
			: { spawnClaudeCodeProcess: (options) => spawnClaudeCodeProcess(options) }),
		canUseTool: async (toolName, sourceInput, permission) => {
			if (!selectedNames.has(toolName)) {
				return { behavior: "deny", message: "Tool is not in the exact AOS MCP selection." };
			}
			let input: FoundationJsonValue;
			try {
				input = asFoundationJson(sourceInput);
			} catch {
				return { behavior: "deny", message: "Tool input is malformed." };
			}
			const decision = await request.requestPermission({
				requestId: permission.requestId,
				toolUseId: permission.toolUseID,
				toolName,
				input,
				signal: permission.signal,
			});
			return decision === "allow"
				? { behavior: "allow", updatedInput: sourceInput, toolUseID: permission.toolUseID }
				: { behavior: "deny", message: "AOS policy denied the tool request.", toolUseID: permission.toolUseID };
		},
	};
}

export async function createPrivateClaudeAgentSdkCompanion(
	options: { readonly executablePath?: string } = {},
): Promise<PrivateClaudeAgentSdkCompanion> {
	let sdk: typeof ClaudeAgentSdk;
	try {
		sdk = await createJiti(import.meta.url).import<typeof ClaudeAgentSdk>("@anthropic-ai/claude-agent-sdk");
	} catch {
		throw new TypeError(
			"The pinned Claude Agent SDK is missing. Install @anthropic-ai/claude-agent-sdk@0.3.246; see https://platform.claude.com/docs/en/agent-sdk/typescript.",
		);
	}
	return Object.freeze({
		sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
		query: (request: PrivateClaudeCompanionQueryRequest) => sdk.query({
			prompt: promptFor(request),
			options: optionsFor(request, options.executablePath, sdk),
		}),
	});
}
