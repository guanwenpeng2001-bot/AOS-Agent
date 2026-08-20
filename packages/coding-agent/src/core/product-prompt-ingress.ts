import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	createAttempt,
	createGoalStore,
	fingerprintFoundationValue,
	FoundationError,
	Result,
	sha256HexValue,
	validateAndVerifyToolReceiptV1,
	type AgentBindingV1,
	type AgentHarness,
	type AttemptReceiptV1,
	type AttemptV1,
	type DispatchV1,
	type FoundationJsonValue,
	type FoundationProviderCapabilityV1,
	type FoundationProviderExecutionOptionsV1,
	type ModelProfileV1,
	type RoleRevisionV1,
	type Session,
	type StepAttemptRecord,
	type TaskExecutorAttemptContextV1,
	type TaskExecutorProvider,
	type ThinkingLevel,
} from "@aos-agent/agent-core";
import type { Api, ImageContent, Model, Models } from "@aos-agent/ai";
import {
	PROMPT_TASK_DEPENDENCY_NAMES,
	createPromptTaskAdapter,
	type PromptTaskCompositionDependenciesV1,
	type PromptTaskDependencyContextV1,
	type PromptTaskDependencyNameV1,
	type PromptTaskExecutionV1,
} from "./prompt-task-adapter.ts";
import { isRuntimeSessionSurfaceV1, type RuntimeSessionSurfaceV1 } from "./runtime-session-surface.ts";

export const BUILTIN_CODING_AGENT_ROLE_ID = "aos.builtin.coding-agent";
export const BUILTIN_CODING_AGENT_PROVIDER_ID = "aos.builtin.coding-agent";
const PRODUCT_PROMPT_INGRESS_OBJECT_TYPE = "coding_agent.product_prompt_ingress";

const DEPENDENCY_FACT_TYPES = {
	context: "context_snapshot",
	model: "model_broker_binding",
	capability: "capability_binding",
	mcp: "mcp_binding",
	policy: "policy_binding",
	sandbox: "sandbox_binding",
	audit: "audit_binding",
	run: "run_binding",
	gate: "task_gate_binding",
	graph: "task_graph_binding",
	credential: "credential_lease_binding",
	adapter: "external_agent_binding",
} as const satisfies Record<PromptTaskDependencyNameV1, string>;

type ProductPromptIngressFactV1 = {
	readonly schemaVersion: 1;
	readonly type: "coding_agent.product_prompt_ingress";
	readonly id: string;
	readonly revision: 1;
	readonly runId: string;
	readonly surface: RuntimeSessionSurfaceV1;
	readonly inputDigest: string;
	readonly submittedAt: string;
} & { readonly [key: string]: FoundationJsonValue };

export interface ProductPromptDependencySnapshotContextV1 {
	readonly runId: string;
	readonly goalId: string;
	readonly taskId: string;
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
}

export interface ProductPromptIngressOptionsV1 {
	readonly session: Session;
	readonly harness: AgentHarness;
	readonly models: Models;
	readonly cwd: string;
	readonly currentModel: () => Model<Api>;
	readonly currentThinkingLevel: () => ThinkingLevel;
	readonly dependencySnapshot: (
		name: PromptTaskDependencyNameV1,
		context: ProductPromptDependencySnapshotContextV1,
	) => FoundationJsonValue;
	readonly now?: () => string;
}

export interface ProductPromptInputV1 {
	readonly prompt: string;
	readonly surface: RuntimeSessionSurfaceV1;
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
	surface: RuntimeSessionSurfaceV1,
): string {
	return fingerprintFoundationValue({ prompt, images: images ?? [], surface }).value;
}

function roleRevision(token: string, modelProfile: ModelProfileV1, timestamp: string): RoleRevisionV1 {
	const base = {
		schemaVersion: 1 as const,
		roleRevisionId: `role_revision_coding_agent_${token}`,
		roleId: BUILTIN_CODING_AGENT_ROLE_ID,
		scope: "global" as const,
		revision: 1,
		slug: "coding-agent",
		name: "AOS Coding Agent",
		description: "Built-in coding-agent product role",
		persona: "Execute the bound coding task through the canonical AgentHarness",
		modelProfileRef: {
			schemaVersion: 1 as const,
			type: "model_profile",
			id: modelProfile.modelProfileId,
			revision: modelProfile.revision,
			fingerprint: modelProfile.fingerprint,
		},
		capabilitySelector: { policy: "all" as const },
		skillSelector: { policy: "all" as const },
		mcpSelector: { policy: "all" as const },
		createdAt: timestamp,
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function modelProfile(token: string, model: Model<Api>, thinkingLevel: ThinkingLevel, timestamp: string): ModelProfileV1 {
	const base = {
		schemaVersion: 1 as const,
		modelProfileId: `model_profile_coding_agent_${token}`,
		name: "AOS Coding Agent prompt route",
		provider: model.provider,
		model: model.id,
		...(thinkingLevel === "off" ? {} : { effort: thinkingLevel }),
		budget: {},
		revision: 1,
		createdAt: timestamp,
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function dependencies(
	token: string,
	providerId: string,
	snapshot: ProductPromptIngressOptionsV1["dependencySnapshot"],
	context: ProductPromptDependencySnapshotContextV1,
): PromptTaskCompositionDependenciesV1 {
	return Object.fromEntries(PROMPT_TASK_DEPENDENCY_NAMES.map((name) => [name, {
		name,
		revision: 1,
		resolve: (_dependencyContext: PromptTaskDependencyContextV1) => {
			const payload = {
				schemaVersion: 1 as const,
				type: DEPENDENCY_FACT_TYPES[name],
				id: `${name}_binding_${token}`,
				revision: 1,
				snapshot: snapshot(name, context),
			};
			return {
				reference: {
					schemaVersion: 1 as const,
					type: payload.type,
					id: payload.id,
					revision: payload.revision,
					fingerprint: fingerprintFoundationValue(payload),
					...(name === "adapter" ? { providerId } : {}),
				},
				payload,
			};
		},
	}])) as unknown as PromptTaskCompositionDependenciesV1;
}

class CodingAgentTaskExecutorProvider implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = BUILTIN_CODING_AGENT_PROVIDER_ID;
	readonly providerClass = "agent" as const;
	private readonly session: Session;

	constructor(session: Session) {
		this.session = session;
	}

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return [{ schemaVersion: 1, id: "foundation.prompt-task", version: 1 }];
	}

	async createAttempt(
		dispatch: DispatchV1,
		_binding: AgentBindingV1,
		context?: TaskExecutorAttemptContextV1,
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

	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
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
			const checked = validateAndVerifyToolReceiptV1(record.payload);
			return checked.ok ? [checked.value] : [];
		});
		const toolsSucceeded = toolStarts.every((start) => {
			const matching = toolReceipts.filter((receipt) => receipt.toolCallId === start.toolCallId);
			return matching.length === 1 && matching[0]?.outcome === "succeeded" && matching[0].sideEffectState === "none";
		});
		const artifacts = toolReceipts.flatMap((receipt) => receipt.artifacts ?? []);
		const uniqueArtifacts = [...new Map(artifacts.map((artifact) => [artifact.artifactId, artifact])).values()];
		const sideEffectUnknown = !modelSucceeded || !toolsSucceeded || toolReceiptRecords.length !== toolReceipts.length;
		const status = assistant.stopReason === "aborted"
			? "cancelled" as const
			: assistant.stopReason === "error" || !modelSucceeded || !toolsSucceeded
				? "failed" as const
				: "succeeded" as const;
		const attemptReceiptId = `attempt_receipt_${correlation.runId}`;
		const producedAt = new Date(assistant.timestamp).toISOString();
		const receipt: AttemptReceiptV1 = {
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
			workerReceiptRefs: [],
			artifacts: uniqueArtifacts,
			...(status === "succeeded" ? {} : {
				error: {
					code: sideEffectUnknown ? "side_effect_unknown" : assistant.stopReason === "aborted" ? "user_aborted" : "agent_run_failed",
					message: assistant.errorMessage ?? (sideEffectUnknown ? "Durable model or tool execution could not prove a terminal success" : "Agent run failed"),
					category: sideEffectUnknown ? "side_effect_unknown" : "unknown",
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
		return Result.ok(receipt);
	}

	async cancelAttempt(_attemptId: string) {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

export class ProductPromptIngressV1 {
	private readonly options: ProductPromptIngressOptionsV1;
	private readonly provider: CodingAgentTaskExecutorProvider;

	constructor(options: ProductPromptIngressOptionsV1) {
		if (options.harness.session !== options.session) {
			throw new FoundationError("session_ledger_conflict", "Product prompt ingress and Harness must share one Session");
		}
		this.options = options;
		this.provider = new CodingAgentTaskExecutorProvider(options.session);
	}

	private async establishIngressFact(
		runId: string,
		prompt: string,
		images: readonly ImageContent[] | undefined,
		surface: RuntimeSessionSurfaceV1,
	): Promise<ProductPromptIngressFactV1> {
		const id = `product_prompt_${promptToken(runId)}`;
		const digest = inputDigest(prompt, images, surface);
		const existing = await this.options.harness.t5.writer.readFact<ProductPromptIngressFactV1>(
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
				!isRuntimeSessionSurfaceV1(fact.surface) ||
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
		const written = await this.options.harness.t5.writer.writeFact<ProductPromptIngressFactV1>({
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

	async execute(input: ProductPromptInputV1): Promise<PromptTaskExecutionV1> {
		if (input.prompt.trim().length === 0) throw new FoundationError("foundation_schema_invalid_shape", "Product prompt must be non-empty");
		if (!isRuntimeSessionSurfaceV1(input.surface)) throw new FoundationError("foundation_schema_invalid_shape", "Product prompt surface is invalid");
		const runId = requireRunId(input.runId ?? randomUUID());
		const ingress = await this.establishIngressFact(runId, input.prompt, input.images, input.surface);
		const token = promptToken(runId);
		const metadata = await this.options.session.getMetadata();
		const goalStore = createGoalStore(this.options.session, { writer: this.options.harness.t5.writer });
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
		const profile = modelProfile(token, model, thinkingLevel, ingress.submittedAt);
		const role = roleRevision(token, profile, ingress.submittedAt);
		const taskId = `task_coding_agent_${token}`;
		const dependencyContext: ProductPromptDependencySnapshotContextV1 = {
			runId,
			goalId: goal.goalId,
			taskId,
			model,
			thinkingLevel,
		};
		const adapter = createPromptTaskAdapter({
			dependencies: dependencies(token, this.provider.providerId, this.options.dependencySnapshot, dependencyContext),
			provider: this.provider,
			harness: {
				session: this.options.session,
				models: this.options.models,
				model,
			},
			runtimeHarness: this.options.harness,
			writer: this.options.harness.t5.writer,
			ownerId: `product-prompt:${metadata.id}`,
		});
		return adapter.execute({
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
			roleRevision: role,
			modelProfile: profile,
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
	}
}
