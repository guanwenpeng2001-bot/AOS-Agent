/**
 * Trusted, private Claude Agent SDK companion entry.
 *
 * This is the only coding-agent module that imports the optional vendor SDK.
 * It is intentionally absent from the package export map and default root.
 */

import {
	createSdkMcpServer,
	query,
	tool,
	type HookCallback,
	type McpServerConfig,
	type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { canonicalFoundationJson, type FoundationJsonValue } from "@aos-agent/agent-core";
import { z } from "zod/v4";
import {
	PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	type PrivateClaudeAgentSdkCompanion,
	type PrivateClaudeCompanionQueryRequest,
	type PrivateClaudeSelectedTool,
} from "../core/vendor-drivers/claude.ts";

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

function sdkTool(request: PrivateClaudeCompanionQueryRequest, selected: PrivateClaudeSelectedTool) {
	return tool(
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

function mcpServers(request: PrivateClaudeCompanionQueryRequest): Record<string, McpServerConfig> {
	const grouped = new Map<string, PrivateClaudeSelectedTool[]>();
	for (const selected of request.tools) {
		const tools = grouped.get(selected.serverName) ?? [];
		tools.push(selected);
		grouped.set(selected.serverName, tools);
	}
	return Object.fromEntries([...grouped.entries()].map(([serverName, tools]) => [
		serverName,
		createSdkMcpServer({
			name: serverName,
			version: "1",
			alwaysLoad: true,
			tools: tools.map((selected) => sdkTool(request, selected)),
		}),
	]));
}

function optionsFor(request: PrivateClaudeCompanionQueryRequest): Options {
	const selectedNames = new Set(request.tools.map((selected) => selected.exposedToolName));
	return {
		abortController: request.abortController,
		allowedTools: [],
		agents: {},
		cwd: request.cwd,
		env: {
			...request.env,
			CLAUDE_AGENT_SDK_CLIENT_APP: "aos-agent/0.84.3",
		},
		hooks: {
			PreToolUse: [{ hooks: [observationHook(request, "PreToolUse")] }],
			PostToolUse: [{ hooks: [observationHook(request, "PostToolUse")] }],
			PostToolUseFailure: [{ hooks: [observationHook(request, "PostToolUseFailure")] }],
		},
		mcpServers: mcpServers(request),
		permissionMode: "default",
		plugins: [],
		...(request.resumeSessionId === undefined ? {} : { resume: request.resumeSessionId }),
		settingSources: [],
		skills: [],
		strictMcpConfig: true,
		tools: [],
		canUseTool: async (toolName, input, permission) => {
			if (!selectedNames.has(toolName)) {
				return { behavior: "deny", message: "Tool is not in the exact AOS MCP selection." };
			}
			let canonicalInput: FoundationJsonValue;
			try {
				canonicalInput = asFoundationJson(input);
			} catch {
				return { behavior: "deny", message: "Tool input is malformed." };
			}
			const decision = await request.requestPermission({
				requestId: permission.requestId,
				toolUseId: permission.toolUseID,
				toolName,
				input: canonicalInput,
				signal: permission.signal,
			});
			return decision === "allow"
				? { behavior: "allow", updatedInput: input, toolUseID: permission.toolUseID }
				: { behavior: "deny", message: "AOS policy denied the tool request.", toolUseID: permission.toolUseID };
		},
	};
}

export function createPrivateClaudeAgentSdkCompanion(): PrivateClaudeAgentSdkCompanion {
	return Object.freeze({
		sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
		query: (request: PrivateClaudeCompanionQueryRequest) => query({
			prompt: request.prompt,
			options: optionsFor(request),
		}),
	});
}
