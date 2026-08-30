import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	createAttempt,
	fingerprintFoundationValue,
	FoundationError,
	Result,
	sha256HexValue,
	validateAttemptReceiptForProvider,
	validateAndVerifyToolReceipt,
	validateToolExecutionResult,
	validateWorkerReceipt,
	validateWorkerReceiptForProvider,
	type AgentBinding,
	type AgentHarness,
	type AttemptReceipt,
	type Attempt,
	type Dispatch,
	type FoundationJsonValue,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ResultValue,
	type ToolExecutionResult,
	type WorkerReceiptRef,
	type Session,
	type StepAttemptRecord,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	type ThinkingLevel,
} from "@aos-agent/agent-core";
import type { Api, ImageContent, Model, Models } from "@aos-agent/ai";
import { createGoalStore } from "../orchestration/goal-store.ts";
import {
	createPromptTaskAdapter,
	type PromptTaskDependencyName,
	type PromptTaskExecution,
	type PromptTaskMcpSelectionSource,
} from "./prompt-task-adapter.ts";
import {
	ProductPromptBindingRevisionAuthority,
	type ProductPromptDependencySnapshotContext,
} from "./prompt-binding-authority.ts";
import { isRuntimeSessionSurface, type RuntimeSessionSurface } from "./session-surface.ts";
import type { SubagentComposition } from "../subagent/composition.ts";

export type { ProductPromptDependencySnapshotContext } from "./prompt-binding-authority.ts";

export const BUILTIN_CODING_AGENT_ROLE_ID = "aos.builtin.coding-agent";
export const BUILTIN_CODING_AGENT_PROVIDER_ID = "aos.builtin.coding-agent";
const PRODUCT_PROMPT_INGRESS_OBJECT_TYPE = "coding_agent.product_prompt_ingress";
const WORKER_TOOL_EXECUTION_OBJECT_TYPE = "coding_agent.worker_tool_execution";

type ProductPromptAbortKind = "cancelled" | "deadline";

interface ProductPromptAbortContext {
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
}

function isDeadlineAbortReason(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const reason = value as { readonly code?: unknown; readonly name?: unknown };
	return reason.code === "deadline_exceeded" ||
		reason.name === "TimeoutError" ||
		reason.name === "AgentDeadlineExceeded" ||
		reason.name === "HarnessDeadlineExceeded";
}

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
	readonly result: ToolExecutionResult;
}

const WORKER_TOOL_EXECUTION_FACT_KEYS = new Set([
	"schemaVersion",
	"type",
	"id",
	"revision",
	"sessionId",
	"laneId",
	"operationId",
	"runId",
	"providerId",
	"taskId",
	"dispatchId",
	"attemptId",
	"bindingId",
	"bindingEpochId",
	"agentInstanceId",
	"result",
]);
const REQUIRED_WORKER_TOOL_EXECUTION_FACT_KEYS = new Set([...WORKER_TOOL_EXECUTION_FACT_KEYS].filter((key) => key !== "runId" && key !== "agentInstanceId"));

function isExactWorkerToolExecutionFactPayload(value: unknown): value is WorkerToolExecutionFactV1 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.every((key) => WORKER_TOOL_EXECUTION_FACT_KEYS.has(key)) && [...REQUIRED_WORKER_TOOL_EXECUTION_FACT_KEYS].every((key) => keys.includes(key));
}

type ProductPromptIngressFactV1 = {
	readonly schemaVersion: 1;
	readonly type: "coding_agent.product_prompt_ingress";
	readonly id: string;
	readonly revision: 1;
	readonly runId: string;
	readonly surface: RuntimeSessionSurface;
	readonly inputDigest: string;
	readonly submittedAt: string;
} & { readonly [key: string]: FoundationJsonValue };

export interface ProductPromptIngressOptions {
	readonly session: Session;
	readonly harness: AgentHarness;
	readonly models: Models;
	readonly cwd: string;
	readonly currentModel: () => Model<Api>;
	readonly currentThinkingLevel: () => ThinkingLevel;
	readonly mcpSelectionSource: PromptTaskMcpSelectionSource;
	readonly dependencySnapshot: (
		name: PromptTaskDependencyName,
		context: ProductPromptDependencySnapshotContext,
	) => FoundationJsonValue;
	/** Explicit trusted Host opt-in. Omission keeps product prompts on the existing path. */
	readonly subagents?: SubagentComposition;
	readonly now?: () => string;
}

export interface ProductPromptInput {
	readonly prompt: string;
	readonly surface: RuntimeSessionSurface;
	readonly images?: readonly ImageContent[];
	readonly continuation?: boolean;
	readonly runId?: string;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
}

function requireRunId(value: string): string {
	if (value.trim().length === 0) throw new FoundationError("invalid_identifier", "Product prompt runId must be non-empty");
	return value;
}

function promptToken(runId: string): string {
	return sha256HexValue(runId).slice(0, 32);
}

function inputDigest(
	prompt: string,
	images: readonly ImageContent[] | undefined,
	surface: RuntimeSessionSurface,
): string {
	return fingerprintFoundationValue({ prompt, images: images ?? [], surface }).value;
}

class CodingAgentTaskExecutorProvider implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = BUILTIN_CODING_AGENT_PROVIDER_ID;
	readonly providerClass = "agent" as const;
	private readonly session: Session;
	private readonly abortContexts = new Map<string, ProductPromptAbortContext>();

	constructor(session: Session) {
		this.session = session;
	}

	bindAbortContext(runId: string, signal: AbortSignal | undefined, deadlineMs: number | undefined): void {
		this.abortContexts.set(runId, {
			...(signal === undefined ? {} : { signal }),
			...(deadlineMs === undefined ? {} : { deadlineAt: Date.now() + deadlineMs }),
		});
	}

	clearAbortContext(runId: string): void {
		this.abortContexts.delete(runId);
	}

	private abortKind(runId: string): ProductPromptAbortKind {
		const context = this.abortContexts.get(runId);
		if (context?.signal?.aborted === true && isDeadlineAbortReason(context.signal.reason)) return "deadline";
		if (context?.deadlineAt !== undefined && Date.now() >= context.deadlineAt) return "deadline";
		return "cancelled";
	}

	private async workerReceiptRefs(
		attempt: Attempt,
		correlation: NonNullable<FoundationProviderExecutionOptions["correlation"]>,
	): Promise<ResultValue<readonly WorkerReceiptRef[], FoundationError>> {
		const executionRecords = await this.session.findFoundationRecords({ kind: "fact", objectType: WORKER_TOOL_EXECUTION_OBJECT_TYPE, includePruned: true, order: "oldestFirst" });
		const byId = new Map<string, WorkerReceiptRef>();
		for (const record of executionRecords) {
			if (record.kind !== "fact") continue;
			const correlationBelongsToAttempt =
				record.correlation.sessionId === correlation.sessionId && record.correlation.laneId === correlation.laneId &&
				record.correlation.runId === correlation.runId && record.correlation.taskId === attempt.taskId &&
				record.correlation.dispatchId === attempt.dispatchId && record.correlation.attemptId === attempt.attemptId &&
				record.correlation.bindingId === attempt.bindingId && record.correlation.bindingEpochId === attempt.bindingEpochIds[0] &&
				record.correlation.agentInstanceId === attempt.agentInstanceId;
			if (!correlationBelongsToAttempt) continue;
			const currentExecution = await this.session.getFoundationObject(WORKER_TOOL_EXECUTION_OBJECT_TYPE, record.objectId);
			if (
				currentExecution === undefined || currentExecution.kind !== "fact" || currentExecution.objectType !== WORKER_TOOL_EXECUTION_OBJECT_TYPE ||
				currentExecution.objectId !== record.objectId || currentExecution.revision !== 1 ||
				canonicalFoundationJson(currentExecution) !== canonicalFoundationJson(record)
			) {
				return Result.err(new FoundationError("worker_receipt_invalid", "Durable Worker ToolExecutionResult is not the current revision 1 fact"));
			}
			if (!isExactWorkerToolExecutionFactPayload(record.payload)) {
				return Result.err(new FoundationError("invalid_correlation", "Durable Worker ToolExecutionResult fact is malformed"));
			}
			const fact = record.payload;
			if (
				record.revision !== 1 || fact.schemaVersion !== 1 || fact.type !== WORKER_TOOL_EXECUTION_OBJECT_TYPE || fact.revision !== 1 || typeof fact.id !== "string" || fact.id !== fact.operationId || record.objectId !== fact.id ||
				fact.sessionId !== correlation.sessionId || fact.laneId !== correlation.laneId || fact.runId !== correlation.runId || typeof fact.operationId !== "string" ||
				typeof fact.providerId !== "string" || typeof fact.taskId !== "string" || typeof fact.dispatchId !== "string" ||
				typeof fact.attemptId !== "string" || fact.bindingId !== attempt.bindingId || fact.bindingEpochId !== attempt.bindingEpochIds[0] || fact.agentInstanceId !== attempt.agentInstanceId ||
				record.correlation.sessionId !== fact.sessionId || record.correlation.laneId !== fact.laneId || record.correlation.runId !== fact.runId ||
				record.correlation.operationId !== fact.operationId || record.correlation.providerId !== fact.providerId || record.correlation.toolCallId !== fact.result?.toolCallId ||
				record.correlation.taskId !== fact.taskId || record.correlation.dispatchId !== fact.dispatchId || record.correlation.attemptId !== fact.attemptId ||
				record.correlation.bindingId !== fact.bindingId || record.correlation.bindingEpochId !== fact.bindingEpochId || record.correlation.agentInstanceId !== fact.agentInstanceId
			) {
				return Result.err(new FoundationError("invalid_correlation", "Durable Worker ToolExecutionResult does not match the current Attempt"));
			}
			const toolResult = validateToolExecutionResult(fact.result);
			if (!toolResult.ok || toolResult.value.toolReceiptRef === undefined) {
				return Result.err(new FoundationError("worker_receipt_invalid", "Durable Worker ToolExecutionResult has no validated receipt reference"));
			}
			const stored = await this.session.getFoundationObject("worker_receipt", toolResult.value.toolReceiptRef);
			if (
				stored === undefined || stored.kind !== "fact" || stored.objectType !== "worker_receipt" || stored.revision !== 1 ||
				stored.objectId !== toolResult.value.toolReceiptRef
			) {
				return Result.err(new FoundationError("worker_receipt_invalid", "ToolExecutionResult references no durable WorkerReceipt"));
			}
			const genericWorker = validateWorkerReceipt(stored.payload);
			if (!genericWorker.ok) return Result.err(new FoundationError("worker_receipt_invalid", "Durable WorkerReceipt fact is malformed"));
			const worker = validateWorkerReceiptForProvider(genericWorker.value, { providerId: fact.providerId, providerClass: "operation_worker" });
			if (!worker.ok) return Result.err(worker.error);
			if (worker.value.taskId !== fact.taskId || worker.value.dispatchId !== fact.dispatchId || worker.value.attemptId !== fact.attemptId) return Result.err(new FoundationError("invalid_correlation", "Durable WorkerReceipt does not match the current Attempt"));
			const workerCorrelation = worker.value.provenance.correlation;
			if (
				worker.value.workerReceiptId !== toolResult.value.toolReceiptRef ||
				worker.value.operationId !== fact.operationId ||
				workerCorrelation === undefined || workerCorrelation.sessionId !== correlation.sessionId || workerCorrelation.laneId !== correlation.laneId ||
				workerCorrelation.runId !== correlation.runId ||
				workerCorrelation.operationId !== fact.operationId ||
				(workerCorrelation.providerId !== undefined && workerCorrelation.providerId !== fact.providerId) ||
				(workerCorrelation.toolCallId !== undefined && workerCorrelation.toolCallId !== toolResult.value.toolCallId) ||
				(workerCorrelation.taskId !== undefined && workerCorrelation.taskId !== attempt.taskId) ||
				(workerCorrelation.dispatchId !== undefined && workerCorrelation.dispatchId !== attempt.dispatchId) ||
				(workerCorrelation.attemptId !== undefined && workerCorrelation.attemptId !== attempt.attemptId) ||
				(workerCorrelation.bindingId !== undefined && workerCorrelation.bindingId !== attempt.bindingId) ||
				(workerCorrelation.bindingEpochId !== undefined && workerCorrelation.bindingEpochId !== attempt.bindingEpochIds[0]) ||
				workerCorrelation.agentInstanceId !== undefined ||
				stored.correlation.sessionId !== workerCorrelation.sessionId || stored.correlation.laneId !== workerCorrelation.laneId ||
				stored.correlation.runId !== fact.runId || stored.correlation.operationId !== fact.operationId ||
				stored.correlation.providerId !== fact.providerId || stored.correlation.toolCallId !== toolResult.value.toolCallId ||
				stored.correlation.taskId !== fact.taskId || stored.correlation.dispatchId !== fact.dispatchId ||
				stored.correlation.attemptId !== fact.attemptId || stored.correlation.bindingId !== fact.bindingId ||
				stored.correlation.bindingEpochId !== fact.bindingEpochId || stored.correlation.agentInstanceId !== fact.agentInstanceId
			) {
				return Result.err(new FoundationError("invalid_correlation", "Durable WorkerReceipt does not match the current Attempt"));
			}
			const reference: WorkerReceiptRef = {
				schemaVersion: 1,
				type: "worker_receipt",
				id: worker.value.workerReceiptId,
				revision: stored.revision,
				providerId: worker.value.sandboxProviderId,
				fingerprint: fingerprintFoundationValue(worker.value),
			};
			const prior = byId.get(reference.id);
			if (prior !== undefined && canonicalFoundationJson(prior) !== canonicalFoundationJson(reference)) return Result.err(new FoundationError("session_ledger_conflict", "Durable WorkerReceipt identity conflicts"));
			byId.set(reference.id, reference);
		}
		if (byId.size > 64) return Result.err(new FoundationError("worker_conflict", "WorkerReceipt reference bound exceeded"));
		return Result.ok([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "foundation.prompt-task", version: 1 }];
	}

	async createAttempt(
		dispatch: Dispatch,
		_binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	) {
		if (context === undefined || context.initialBindingEpoch.agentInstanceId === undefined) {
			return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Coding-agent provider requires the bound AgentInstance"));
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			agentInstanceId: context.initialBindingEpoch.agentInstanceId,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		const correlation = options?.correlation;
		if (
			correlation?.runId === undefined ||
			correlation.operationId !== correlation.runId ||
			correlation.taskId !== attempt.taskId ||
			correlation.dispatchId !== attempt.dispatchId ||
			correlation.attemptId !== attempt.attemptId ||
			correlation.bindingId !== attempt.bindingId ||
			correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			correlation.agentInstanceId !== attempt.agentInstanceId
		) {
			return Result.err(new FoundationError("invalid_correlation", "Coding-agent provider requires the exact Harness execution correlation"));
		}
		const records = await this.session.findRecords({
			lane: correlation.laneId,
			runId: correlation.runId,
			order: "oldestFirst",
		});
		const assistantStep = records
			.filter((record): record is StepAttemptRecord => record.type === "step_attempt" && record.step === "assistant")
			.at(-1);
		const assistantEntry = assistantStep === undefined
			? undefined
			: await this.session.getEntry(assistantStep.resultEntryId);
		const assistant = assistantEntry?.type === "message" && assistantEntry.message.role === "assistant"
			? assistantEntry.message
			: undefined;
		if (assistant === undefined) {
			return Result.err(new FoundationError("side_effect_unknown", "Coding-agent provider could not read the durable assistant result"));
		}

		const modelRecords = await this.session.findFoundationRecords({
			objectType: "model_invocation",
			includePruned: true,
			order: "oldestFirst",
			correlation: { runId: correlation.runId, operationId: correlation.runId },
		});
		const modelIntents = modelRecords.filter((record) => record.kind === "intent");
		const modelFacts = modelRecords.filter((record) => record.kind === "fact");
		const latestModelFact = modelFacts.at(-1);
		const allModelIntentsSettled = modelIntents.length > 0 && modelIntents.every((intent) =>
			modelFacts.some((fact) => fact.objectId === intent.objectId),
		);
		const latestModelPayload = latestModelFact?.kind === "fact" && latestModelFact.payload !== null && typeof latestModelFact.payload === "object" && !Array.isArray(latestModelFact.payload)
			? latestModelFact.payload
			: undefined;
		const modelSucceeded = allModelIntentsSettled && latestModelPayload?.status === "succeeded" && latestModelPayload.sideEffectState === "none";
		const promptAbort = assistant.stopReason === "aborted" ? this.abortKind(correlation.runId) : undefined;
		const modelCancellationSettled = promptAbort !== undefined;

		const toolStarts = records.filter((record) => record.type === "tool_started");
		const toolReceiptRecords = await this.session.findFoundationRecords({
			kind: "fact",
			objectType: "tool_receipt",
			includePruned: true,
			order: "oldestFirst",
			correlation: { runId: correlation.runId, operationId: correlation.runId },
		});
		const toolReceipts = toolReceiptRecords.flatMap((record) => {
			if (record.kind !== "fact") return [];
			const checked = validateAndVerifyToolReceipt(record.payload);
			return checked.ok ? [checked.value] : [];
		});
		const toolsSucceeded = toolStarts.every((start) => {
			const matching = toolReceipts.filter((receipt) => receipt.toolCallId === start.toolCallId);
			return matching.length === 1 && matching[0]?.outcome === "succeeded" && matching[0].sideEffectState === "none";
		});
		const artifacts = toolReceipts.flatMap((receipt) => receipt.artifacts ?? []);
		const uniqueArtifacts = [...new Map(artifacts.map((artifact) => [artifact.artifactId, artifact])).values()];
		const sideEffectUnknown = !modelSucceeded && !modelCancellationSettled || !toolsSucceeded || toolReceiptRecords.length !== toolReceipts.length;
		const status = sideEffectUnknown || promptAbort === "deadline" || assistant.stopReason === "error"
			? "failed" as const
			: promptAbort === "cancelled"
				? "cancelled" as const
				: "succeeded" as const;
		const attemptReceiptId = `attempt_receipt_${correlation.runId}`;
		const producedAt = new Date(assistant.timestamp).toISOString();
		const workerReceiptRefs = await this.workerReceiptRefs(attempt, correlation);
		if (!workerReceiptRefs.ok) return workerReceiptRefs;
		const receipt: AttemptReceipt = {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			agentInstanceId: attempt.agentInstanceId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status,
			workerReceiptRefs: workerReceiptRefs.value,
			artifacts: uniqueArtifacts,
			...(status === "succeeded" ? {} : {
				error: {
					code: sideEffectUnknown ? "side_effect_unknown" : promptAbort === "deadline" ? "run_deadline_exceeded" : promptAbort === "cancelled" ? "user_aborted" : "agent_run_failed",
					message: assistant.errorMessage ?? (sideEffectUnknown ? "Durable model or tool execution could not prove a terminal success" : promptAbort === "deadline" ? "Run deadline was exceeded" : promptAbort === "cancelled" ? "Agent run was cancelled" : "Agent run failed"),
					category: sideEffectUnknown ? "side_effect_unknown" : promptAbort === "deadline" ? "deadline" : promptAbort === "cancelled" ? "cancelled" : "unknown",
					retryable: false,
				},
			}),
			provenance: {
				producerKind: "agent_executor",
				providerId: this.providerId,
				producedAt,
				correlation: { ...correlation, attemptReceiptId },
			},
			sideEffectState: sideEffectUnknown ? "side_effect_unknown" : "none",
		};
		return validateAttemptReceiptForProvider(receipt, { providerId: this.providerId, providerClass: this.providerClass });
	}

	async cancelAttempt(_attemptId: string) {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

export class ProductPromptIngress {
	private readonly options: ProductPromptIngressOptions;
	private readonly provider: CodingAgentTaskExecutorProvider;
	private readonly bindingAuthority: ProductPromptBindingRevisionAuthority;

	constructor(options: ProductPromptIngressOptions) {
		if (options.harness.session !== options.session) {
			throw new FoundationError("session_ledger_conflict", "Product prompt ingress and Harness must share one Session");
		}
		this.options = options;
		this.provider = new CodingAgentTaskExecutorProvider(options.session);
		this.bindingAuthority = new ProductPromptBindingRevisionAuthority({
			session: options.session,
			roleId: BUILTIN_CODING_AGENT_ROLE_ID,
			providerId: this.provider.providerId,
			dependencySnapshot: options.dependencySnapshot,
		});
	}

	private async establishIngressFact(
		runId: string,
		prompt: string,
		images: readonly ImageContent[] | undefined,
		surface: RuntimeSessionSurface,
	): Promise<ProductPromptIngressFactV1> {
		const id = `product_prompt_${promptToken(runId)}`;
		const digest = inputDigest(prompt, images, surface);
		const existing = await this.options.harness.ledger.writer.readFact<ProductPromptIngressFactV1>(
			PRODUCT_PROMPT_INGRESS_OBJECT_TYPE,
			id,
		);
		if (existing !== undefined) {
			const fact = existing.payload;
			if (
				fact.schemaVersion !== 1 ||
				fact.type !== PRODUCT_PROMPT_INGRESS_OBJECT_TYPE ||
				fact.id !== id ||
				fact.revision !== 1 ||
				fact.runId !== runId ||
				!isRuntimeSessionSurface(fact.surface) ||
				fact.surface !== surface ||
				fact.inputDigest !== digest ||
				Number.isNaN(Date.parse(fact.submittedAt))
			) {
				throw new FoundationError("session_ledger_conflict", `Product prompt runId ${runId} conflicts with its durable ingress fact`);
			}
			return fact;
		}
		const submittedAt = (this.options.now ?? (() => new Date().toISOString()))();
		if (Number.isNaN(Date.parse(submittedAt))) throw new FoundationError("foundation_schema_invalid_shape", "Product prompt clock returned an invalid timestamp");
		const fact: ProductPromptIngressFactV1 = {
			schemaVersion: 1,
			type: PRODUCT_PROMPT_INGRESS_OBJECT_TYPE,
			id,
			revision: 1,
			runId,
			surface,
			inputDigest: digest,
			submittedAt,
		};
		const written = await this.options.harness.ledger.writer.writeFact<ProductPromptIngressFactV1>({
			objectType: PRODUCT_PROMPT_INGRESS_OBJECT_TYPE,
			objectId: id,
			payload: fact,
			clientRequestId: `product-prompt:${promptToken(runId)}`,
			expectedRevision: 0,
			correlation: { runId, operationId: runId },
		});
		if (canonicalFoundationJson(written.payload) !== canonicalFoundationJson(fact)) {
			throw new FoundationError("session_ledger_conflict", `Product prompt runId ${runId} replayed with different input`);
		}
		return written.payload;
	}

	async execute(input: ProductPromptInput): Promise<PromptTaskExecution> {
		if (input.prompt.trim().length === 0) throw new FoundationError("foundation_schema_invalid_shape", "Product prompt must be non-empty");
		if (!isRuntimeSessionSurface(input.surface)) throw new FoundationError("foundation_schema_invalid_shape", "Product prompt surface is invalid");
		const runId = requireRunId(input.runId ?? randomUUID());
		const ingress = await this.establishIngressFact(runId, input.prompt, input.images, input.surface);
		const token = promptToken(runId);
		const metadata = await this.options.session.getMetadata();
		const goalStore = createGoalStore(this.options.session, { writer: this.options.harness.ledger.writer });
		const goal = await goalStore.create({
			sessionId: metadata.id,
			title: "AOS Coding Agent session",
			description: "Implicit product Goal for aos.builtin.coding-agent",
		}, {
			clientRequestId: `product-prompt:implicit-goal:${metadata.id}:${BUILTIN_CODING_AGENT_ROLE_ID}`,
			expectedRevision: 0,
		});
		const model = this.options.currentModel();
		const thinkingLevel = this.options.currentThinkingLevel();
		const taskId = `task_coding_agent_${token}`;
		const dependencyContext: ProductPromptDependencySnapshotContext = {
			runId,
			goalId: goal.goalId,
			taskId,
			model,
			thinkingLevel,
		};
		const bindingFacts = await this.bindingAuthority.resolve(dependencyContext);
		const subagentRoles = this.options.subagents?.productPromptRoles();
		const adapter = createPromptTaskAdapter({
			dependencies: bindingFacts.dependencies,
			provider: this.provider,
			mcpSelectionSource: this.options.mcpSelectionSource,
			harness: {
				session: this.options.session,
				models: this.options.models,
				model,
			},
			runtimeHarness: this.options.harness,
			writer: this.options.harness.ledger.writer,
			ownerId: `product-prompt:${metadata.id}`,
			...(subagentRoles === undefined ? {} : { subagentRoles }),
		});
		this.provider.bindAbortContext(runId, input.signal, input.deadlineMs);
		try {
			return await adapter.execute({
				prompt: input.prompt,
				...(input.images === undefined ? {} : { images: input.images }),
				...(input.continuation === true ? { continuation: true } : {}),
				runId,
				task: {
					taskId,
					goalId: goal.goalId,
					kind: "task",
					title: "Coding-agent prompt",
					description: "One product prompt executed by the built-in coding-agent role",
					workspace: this.options.cwd,
					capabilityRefs: [],
					inputs: [],
					expectedOutputs: [],
					budget: {},
					acceptanceCriteria: [],
				},
				roleRevision: bindingFacts.roleRevision,
				modelProfile: bindingFacts.modelProfile,
				identity: {
					bindingId: `binding_coding_agent_${token}`,
					dispatchId: `dispatch_coding_agent_${token}`,
					attemptId: `attempt_coding_agent_${token}`,
					bindingEpochId: `binding_epoch_coding_agent_${token}`,
					agentInstanceId: `agent_instance_coding_agent_${token}`,
				},
				settlement: { artifacts: [], tests: [], evidence: [] },
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
				now: () => ingress.submittedAt,
			});
		} finally {
			this.provider.clearAbortContext(runId);
		}
	}
}
