import {
	AgentHarness,
	canonicalFoundationJson,
	createFoundationToolGatewayV1,
	createSandboxOperationToolGatewayProviderV1,
	executeOperationV1,
	FoundationError,
	Result,
	SessionLedgerV1,
	type AgentHarnessOptions,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	validateFoundationProviderCapabilityV1,
	validateToolExecutionResultV1,
	validateAttemptV1,
	validateWorkerReceipt,
	validateWorkerReceiptForProviderV1,
	type ExecutionEnv,
	type ExecutionToolContext,
	type HarnessTool,
	type FoundationJsonValue,
	type ExecutionCorrelationV1,
	type SandboxOperationProvider,
	type SandboxOperationRequestV1,
	type SessionLedgerWriter,
	type ToolGatewayRouteV1,
	type ToolExecutionResultV1,
	type WorkerReceiptV1,
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

const WORKER_TOOL_EXECUTION_OBJECT_TYPE = "coding_agent.worker_tool_execution";

interface WorkerToolExecutionFactV1 {
	readonly schemaVersion: 1;
	readonly type: typeof WORKER_TOOL_EXECUTION_OBJECT_TYPE;
	readonly id: string;
	readonly revision: 1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly operationId: string;
	readonly runId?: string;
	readonly providerId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId?: string;
	readonly result: ToolExecutionResultV1;
}

async function appendImmutableWorkerFact<TPayload>(
	ledger: SessionLedgerV1,
	objectType: string,
	objectId: string,
	payload: TPayload,
	options: Parameters<SessionLedgerV1["appendFact"]>[3],
): Promise<TPayload> {
	const existing = await ledger.get(objectType, objectId);
	if (existing !== undefined) {
		if (existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return existing.payload as TPayload;
		throw new FoundationError("session_ledger_conflict", `Worker durable fact ${objectType}/${objectId} conflicts`);
	}
	try {
		const appended = await ledger.appendFact(objectType, objectId, payload, options);
		return appended.payload;
	} catch (error) {
		const raced = await ledger.get(objectType, objectId);
		if (raced?.kind === "fact" && canonicalFoundationJson(raced.payload) === canonicalFoundationJson(payload)) return raced.payload as TPayload;
		throw error;
	}
}

async function persistWorkerToolExecution(
	session: AgentHarnessOptions["session"],
	providerId: string,
	request: SandboxOperationRequestV1,
	runId: string | undefined,
	writer: SessionLedgerWriter,
	receipt: WorkerReceiptV1,
	result: ToolExecutionResultV1,
): Promise<void> {
	const checkedReceipt = validateWorkerReceipt(receipt);
	if (!checkedReceipt.ok) throw checkedReceipt.error;
	const conformedReceipt = validateWorkerReceiptForProviderV1(checkedReceipt.value, { providerId, providerClass: "operation_worker" });
	if (!conformedReceipt.ok) throw conformedReceipt.error;
	const checkedResult = validateToolExecutionResultV1(result);
	if (!checkedResult.ok) throw checkedResult.error;
	const metadata = await session.getMetadata();
	const receiptCorrelation = conformedReceipt.value.provenance.correlation;
	if (
		receiptCorrelation === undefined || receiptCorrelation.sessionId !== metadata.id || receiptCorrelation.laneId !== "main" ||
		(runId === undefined ? receiptCorrelation.runId !== undefined : receiptCorrelation.runId !== runId) || receiptCorrelation.operationId !== request.operationId ||
		(receiptCorrelation.providerId !== undefined && receiptCorrelation.providerId !== providerId) ||
		(receiptCorrelation.toolCallId !== undefined && receiptCorrelation.toolCallId !== request.toolCallId) ||
		(receiptCorrelation.taskId !== undefined && receiptCorrelation.taskId !== request.taskId) ||
		(receiptCorrelation.dispatchId !== undefined && receiptCorrelation.dispatchId !== request.dispatchId) ||
		(receiptCorrelation.attemptId !== undefined && receiptCorrelation.attemptId !== request.attemptId) ||
		(receiptCorrelation.bindingId !== undefined && receiptCorrelation.bindingId !== request.bindingId) ||
		(receiptCorrelation.bindingEpochId !== undefined && receiptCorrelation.bindingEpochId !== request.bindingEpochId) || receiptCorrelation.agentInstanceId !== undefined
	) throw new FoundationError("invalid_correlation", "WorkerReceipt does not match the exact Host execution correlation");
	const fact: WorkerToolExecutionFactV1 = {
		schemaVersion: 1,
		type: WORKER_TOOL_EXECUTION_OBJECT_TYPE,
		id: request.operationId,
		revision: 1,
		sessionId: metadata.id,
		laneId: "main",
		operationId: request.operationId,
		...(runId === undefined ? {} : { runId }),
		providerId,
		taskId: request.taskId as string,
		dispatchId: request.dispatchId as string,
		attemptId: request.attemptId as string,
		bindingId: request.bindingId as string,
		bindingEpochId: request.bindingEpochId as string,
		...(request.agentInstanceId === undefined ? {} : { agentInstanceId: request.agentInstanceId }),
		result: checkedResult.value,
	};
	const ledger = new SessionLedgerV1(session, { ownerId: `coding-agent-worker-receipt:${providerId}`, writer });
	await appendImmutableWorkerFact(ledger, "worker_receipt", conformedReceipt.value.workerReceiptId, conformedReceipt.value, {
		clientRequestId: `worker-receipt:${conformedReceipt.value.workerReceiptId}`,
		expectedRevision: 0,
		correlation: {
			operationId: request.operationId,
			...(runId === undefined ? {} : { runId }),
			providerId,
			toolCallId: request.toolCallId,
			taskId: request.taskId,
			dispatchId: request.dispatchId,
			attemptId: request.attemptId,
			bindingId: request.bindingId,
			bindingEpochId: request.bindingEpochId,
			...(request.agentInstanceId === undefined ? {} : { agentInstanceId: request.agentInstanceId }),
		},
	});
	await appendImmutableWorkerFact(ledger, WORKER_TOOL_EXECUTION_OBJECT_TYPE, request.operationId, fact, {
		clientRequestId: `worker-tool-execution:${request.operationId}`,
		expectedRevision: 0,
		correlation: {
			operationId: request.operationId,
			...(runId === undefined ? {} : { runId }),
			providerId,
			toolCallId: request.toolCallId,
			...(request.taskId === undefined ? {} : { taskId: request.taskId }),
			...(request.dispatchId === undefined ? {} : { dispatchId: request.dispatchId }),
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			bindingId: request.bindingId,
			bindingEpochId: request.bindingEpochId,
			...(request.agentInstanceId === undefined ? {} : { agentInstanceId: request.agentInstanceId }),
		},
	});
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
	const sessionMetadata = await options.session.getMetadata();
	const operationWorker: SandboxOperationProvider = {
		schemaVersion: 1,
		providerClass: "operation_worker",
		providerId: workerSandbox.provider.providerId,
		async capabilities() {
			return workerCapabilities;
		},
		async start(request: SandboxOperationRequestV1, executionOptions = {}) {
			const { bindingId, bindingEpochId, taskId, dispatchId, attemptId } = request;
			if (
				taskId === undefined || dispatchId === undefined || attemptId === undefined ||
				bindingId === undefined || bindingEpochId === undefined || bindingId.length === 0 || bindingEpochId.length === 0 ||
				request.toolCallId === undefined || request.toolName === undefined
			) {
				return Result.err(new FoundationError("invalid_correlation", "Sandbox Worker execution requires the exact Attempt correlation"));
			}
			const attemptRecords = await options.session.findFoundationRecords({ kind: "fact", objectType: "attempt", objectId: attemptId, includePruned: true, order: "oldestFirst" });
			const attemptFacts = attemptRecords.filter((record): record is typeof attemptRecords[number] & { kind: "fact" } => record.kind === "fact" && record.objectId === attemptId);
			let runId: string | undefined;
			if (attemptFacts.length > 1) return Result.err(new FoundationError("session_ledger_conflict", "Sandbox Worker Attempt fact is ambiguous"));
			if (attemptFacts.length === 1) {
				const attemptFact = attemptFacts[0];
				const checkedAttempt = validateAttemptV1(attemptFact.payload);
				if (attemptFact.revision !== 1 || !checkedAttempt.ok || checkedAttempt.value.attemptId !== attemptId || checkedAttempt.value.taskId !== taskId || checkedAttempt.value.dispatchId !== dispatchId || checkedAttempt.value.bindingId !== bindingId || checkedAttempt.value.bindingEpochIds[0] !== bindingEpochId || checkedAttempt.value.agentInstanceId !== request.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Sandbox Worker Attempt fact does not match the request"));
				const intents = await options.session.findFoundationRecords({ kind: "intent", objectType: "attempt", includePruned: true, order: "oldestFirst" });
				const matchingIntents = intents.filter((record) => {
					if (record.kind !== "intent" || record.payload === undefined || record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) return false;
					const payload = record.payload as { readonly attemptId?: unknown; readonly taskId?: unknown; readonly dispatchId?: unknown; readonly bindingId?: unknown; readonly bindingEpochIds?: unknown; readonly agentInstanceId?: unknown; readonly runId?: unknown };
					const candidateRunId = payload.runId;
					return record.revision === 1 && typeof candidateRunId === "string" && record.objectId === `attempt_${candidateRunId}` && record.clientRequestId === `harness:intent:${candidateRunId}` && record.correlation.sessionId === sessionMetadata.id && record.correlation.laneId === "main" && record.correlation.runId === candidateRunId && record.correlation.operationId === candidateRunId && payload.attemptId === record.objectId && payload.taskId === checkedAttempt.value.taskId && payload.dispatchId === checkedAttempt.value.dispatchId && payload.bindingId === checkedAttempt.value.bindingId && Array.isArray(payload.bindingEpochIds) && payload.bindingEpochIds[0] === checkedAttempt.value.bindingEpochIds[0] && payload.agentInstanceId === checkedAttempt.value.agentInstanceId;
				});
				const matchingIntent = matchingIntents[0];
				if (matchingIntents.length !== 1 || matchingIntent?.kind !== "intent" || matchingIntent.payload === undefined || matchingIntent.payload === null || typeof matchingIntent.payload !== "object" || Array.isArray(matchingIntent.payload)) return Result.err(new FoundationError("invalid_correlation", "Sandbox Worker Attempt requires exactly one matching Harness intent"));
				runId = (matchingIntent.payload as { readonly runId: string }).runId;
			}
			const correlation: ExecutionCorrelationV1 = {
				sessionId: sessionMetadata.id,
				laneId: "main",
				operationId: request.operationId,
				...(runId === undefined ? {} : { runId }),
				providerId: workerSandbox.provider.providerId,
				toolCallId: request.toolCallId,
				bindingId,
				bindingEpochId,
				taskId,
				dispatchId,
				attemptId,
				revision: 0,
			};
			const executed = await executeOperationV1({
				provider: workerSandbox.provider,
				request,
				correlation,
				...(executionOptions.signal === undefined ? {} : { signal: executionOptions.signal }),
			});
			if (!executed.ok) return executed;
			const receipt = executed.value;
			const result: ToolExecutionResultV1 = {
				schemaVersion: 1,
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				ok: receipt.status === "succeeded",
				sideEffectState: receipt.sideEffectState,
				toolReceiptRef: receipt.workerReceiptId,
				...(receipt.artifacts === undefined ? {} : { artifacts: [...receipt.artifacts] }),
				...(receipt.error === undefined ? {} : { error: receipt.error }),
			};
			try {
				await persistWorkerToolExecution(options.session, workerSandbox.provider.providerId, request, runId, getHarness().t5.writer, receipt, result);
			} catch (error) {
				if (error instanceof FoundationError) return Result.err(error);
				return Result.err(new FoundationError("worker_persistence_failed", `Sandbox WorkerReceipt persistence failed: ${error instanceof Error ? error.message : "unknown persistence error"}`));
			}
			return executed;
		},
		cancel: (operationId) => workerSandbox.provider.cancel(operationId),
		dispose: () => workerSandbox.provider.dispose(),
	};
	const sandboxProvider = createSandboxOperationToolGatewayProviderV1({
		providerId: operationWorker.providerId,
		routes: workerSandbox.routes,
		sandbox: operationWorker,
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
