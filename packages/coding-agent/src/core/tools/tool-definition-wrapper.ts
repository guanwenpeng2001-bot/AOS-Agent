import type { AgentTool } from "@aos-agent/agent-core";
import type { TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

type PromptAwareAgentTool<TParameters extends TSchema, TDetails> = AgentTool<TParameters, TDetails> & Pick<
	ToolDefinition<TParameters, TDetails>,
	"promptSnippet" | "promptGuidelines"
>;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParameters extends TSchema = TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParameters, TDetails>,
	ctxFactory?: () => ExtensionContext,
): PromptAwareAgentTool<TParameters, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
