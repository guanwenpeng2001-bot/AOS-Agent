import {
	AgentHarness,
	createFoundationToolGatewayV1,
	createSandboxOperationToolGatewayProviderV1,
	type AgentHarnessOptions,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	validateFoundationProviderCapabilityV1,
	type ExecutionEnv,
	type ExecutionToolContext,
	type HarnessTool,
	type FoundationJsonValue,
	type SandboxOperationProvider,
	type ToolGatewayRouteV1,
} from "@aos-agent/agent-core";
import type { Static, TSchema } from "typebox";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";

export interface CodingAgentHarnessTool extends HarnessTool {
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
}

function createCodingAgentHarnessTool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
	prompt: Required<Pick<CodingAgentHarnessTool, "promptSnippet" | "promptGuidelines">>,
): CodingAgentHarnessTool {
	return {
		...tool,
		...prompt,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as Static<TParameters>, signal, onUpdate, context),
	};
}

export interface CreateCodingAgentHarnessOptions extends Omit<AgentHarnessOptions, "toolContext" | "tools"> {
	env: ExecutionEnv;
	bashCommandPrefix?: string;
	/** Path to the JSONL session file exposed to default bash commands as AOS_AGENT_SESSION_FILE. */
	sessionFile?: string;
	tools?: CodingAgentHarnessTool[];
	systemPromptOptions?: Omit<BuildSystemPromptOptions, "cwd" | "promptGuidelines" | "selectedTools" | "toolSnippets">;
	/** Explicit opt-in for the Foundation sandbox ToolGateway route. */
	workerSandbox?: {
		readonly provider: SandboxOperationProvider;
		readonly routes: readonly ToolGatewayRouteV1[];
		readonly onOperationPayload?: (operationId: string, payload: FoundationJsonValue) => void;
	};
}

export interface BuildCodingAgentHarnessSystemPromptOptions {
	cwd: string;
	tools: readonly CodingAgentHarnessTool[];
	activeToolNames: readonly string[];
	systemPromptOptions?: CreateCodingAgentHarnessOptions["systemPromptOptions"];
}

export function buildCodingAgentHarnessSystemPrompt(options: BuildCodingAgentHarnessSystemPromptOptions): string {
	const activeTools = options.activeToolNames.flatMap((name) => {
		const tool = options.tools.find((candidate) => candidate.name === name);
		return tool ? [tool] : [];
	});
	const toolSnippets = Object.fromEntries(
		activeTools.flatMap((tool) => {
			const promptSnippet = tool.promptSnippet
				?.replace(/[\r\n]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			return promptSnippet ? [[tool.name, promptSnippet]] : [];
		}),
	);
	const promptGuidelines = activeTools.flatMap((tool) => tool.promptGuidelines ?? []);
	return buildSystemPrompt({
		...options.systemPromptOptions,
		cwd: options.cwd,
		selectedTools: activeTools.map((tool) => tool.name),
		toolSnippets,
		promptGuidelines,
	});
}

export async function createCodingAgentHarness(options: CreateCodingAgentHarnessOptions) {
	const {
		env,
		bashCommandPrefix,
		sessionFile,
		systemPromptOptions,
		workerSandbox,
		tools: providedTools,
		activeToolNames: providedActiveToolNames,
		systemPrompt: providedSystemPrompt,
		...harnessOptions
	} = options;
	let harness: AgentHarness | undefined;
	const getHarness = (): AgentHarness => {
		if (!harness) throw new Error("Coding-agent Harness callback ran before Harness initialization");
		return harness;
	};
	let tools = providedTools;
	if (tools === undefined) {
		const metadata = await options.session.getMetadata();
		const toolContext = { env } satisfies ExecutionToolContext;
		tools = [
			createCodingAgentHarnessTool(createReadTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: readToolSystemPromptContribution.snippet,
				promptGuidelines: readToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(
				createBashTool<ExecutionToolContext>({
					commandPrefix: bashCommandPrefix,
					prepare: async (execution) => {
						const currentHarness = getHarness();
						const [model, thinkingLevel] = await Promise.all([
							currentHarness.getModel(),
							currentHarness.getThinkingLevel(),
						]);
						execution.env.AOS_AGENT_SESSION_ID = metadata.id;
						execution.env.AOS_AGENT_SESSION_FILE = sessionFile ?? "";
						execution.env.AOS_AGENT_PROVIDER = model.provider;
						execution.env.AOS_AGENT_MODEL = model.id;
						execution.env.AOS_AGENT_REASONING_LEVEL = thinkingLevel;
					},
				}),
				toolContext,
				{
					promptSnippet: bashToolSystemPromptContribution.snippet,
					promptGuidelines: bashToolSystemPromptContribution.guidelines,
				},
			),
			createCodingAgentHarnessTool(createEditTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: editToolSystemPromptContribution.snippet,
				promptGuidelines: editToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(createWriteTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: writeToolSystemPromptContribution.snippet,
				promptGuidelines: writeToolSystemPromptContribution.guidelines,
			}),
		];
	}
	const activeToolNames = [...(providedActiveToolNames ?? tools.map((tool) => tool.name))];
	const systemPrompt =
		providedSystemPrompt ??
		(async () => {
			const currentHarness = getHarness();
			const [currentTools, currentActiveToolNames] = await Promise.all([
				currentHarness.getTools(),
				currentHarness.getActiveTools(),
			]);
			return buildCodingAgentHarnessSystemPrompt({
				cwd: env.cwd,
				tools: currentTools,
				activeToolNames: currentActiveToolNames,
				systemPromptOptions,
			});
		});
	const created = await AgentHarness.create({
		...harnessOptions,
		tools,
		activeToolNames,
		systemPrompt,
	});
	harness = created.harness;
	if (workerSandbox === undefined) return created;
	const workerCapabilities = Object.freeze((await workerSandbox.provider.capabilities()).map((capability) => {
		const validated = validateFoundationProviderCapabilityV1(capability);
		if (!validated.ok) throw validated.error;
		return Object.freeze({ ...validated.value });
	}));
	const sandboxProvider = createSandboxOperationToolGatewayProviderV1({
		providerId: workerSandbox.provider.providerId,
		routes: workerSandbox.routes,
		sandbox: workerSandbox.provider,
		capabilities: workerCapabilities,
		...(workerSandbox.onOperationPayload === undefined
			? {}
			: { onOperationPayload: workerSandbox.onOperationPayload }),
	});
	return {
		...created,
		operationToolGateway: createFoundationToolGatewayV1({
			gatewayId: `${workerSandbox.provider.providerId}:tool-gateway`,
			providers: [sandboxProvider],
		}),
	};
}
