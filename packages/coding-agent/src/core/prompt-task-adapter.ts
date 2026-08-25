import {
	canonicalFoundationJson,
	type AgentHarness,
	type AgentHarnessFoundationExecution,
	createAgentInstance,
	createHostTerminalGateAuthority,
	LayeredResultSettlement,
	createOrderedBindingEpoch,
	createTaskEnvelope,
	fingerprintFoundationValue,
	type FoundationError,
	persistTaskEnvelopeBeforeResolver,
	resolveAgentBinding,
	SessionLedger,
	validateDispatch,
	validateAgentInstance,
	validateProviderJson,
	validateRoleRevision,
	validateSecretFreeModelProfile,
	validateVersionedReference,
	type AcceptanceFact,
	type AgentBinding,
	type AgentInstance,
	type ArtifactRef,
	type AttemptReceipt,
	type BindingEpoch,
	type Dispatch,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type ModelProfile,
	type RevisionReference,
	type Result as ResultValue,
	type RoleRevision,
	type RoleRegistry,
	type RunOutcome,
	type RunReceipt,
	type SessionLedgerWriter,
	type TaskEnvelope,
	type TaskExecutorProvider,
	type TaskResult,
	type ValidationResult,
} from "@aos-agent/agent-core";
import type { ImageContent } from "@aos-agent/ai";
import { createCodingAgentHarness, type CreateCodingAgentHarnessOptions } from "../server/create-harness.ts";

export const PROMPT_TASK_DEPENDENCY_NAMES = [
	"context",
	"model",
	"capability",
	"mcp",
	"policy",
	"sandbox",
	"audit",
	"run",
	"gate",
	"graph",
	"credential",
	"adapter",
] as const;

export type PromptTaskDependencyName = (typeof PROMPT_TASK_DEPENDENCY_NAMES)[number];

const PROMPT_TASK_DEPENDENCY_FACT_TYPES = {
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
} as const satisfies Record<PromptTaskDependencyName, string>;

export type PromptTaskCompositionErrorCode =
	| "prompt_task_dependency_missing"
	| "prompt_task_dependency_invalid"
	| "prompt_task_input_invalid"
	| "prompt_task_binding_invalid"
	| "prompt_task_receipt_missing";

export class PromptTaskCompositionError extends Error {
	readonly code: PromptTaskCompositionErrorCode;
	readonly dependency?: PromptTaskDependencyName;

	constructor(code: PromptTaskCompositionErrorCode, message: string, dependency?: PromptTaskDependencyName, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PromptTaskCompositionError";
		this.code = code;
		this.dependency = dependency;
	}
}

export interface PromptTaskDependencyResolution {
	readonly reference: RevisionReference;
	readonly payload: FoundationJsonValue;
}

export interface PromptTaskDependencyContext {
	readonly prompt: string;
	readonly task: TaskEnvelope;
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
}

export interface PromptTaskDependency<TName extends PromptTaskDependencyName = PromptTaskDependencyName> {
	readonly name: TName;
	readonly revision: number;
	resolve(context: PromptTaskDependencyContext): PromptTaskDependencyResolution | Promise<PromptTaskDependencyResolution>;
}

export type PromptTaskCompositionDependencies = {
	readonly [TName in PromptTaskDependencyName]: PromptTaskDependency<TName>;
};

export type PromptTaskEnvelopeInput = Omit<
	TaskEnvelope,
	"schemaVersion" | "goal" | "fingerprint" | "status" | "createdAt" | "updatedAt"
>;

export interface PromptTaskIdentity {
	readonly bindingId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId?: string;
}

export interface PromptTaskSettlement {
	readonly summary?: string;
	readonly artifacts: readonly ArtifactRef[];
	readonly diff?: ArtifactRef;
	readonly tests: readonly ValidationResult[];
	readonly evidence: readonly AcceptanceFact[];
}

export interface PromptTaskInput {
	readonly prompt: string;
	readonly images?: readonly ImageContent[];
	readonly continuation?: boolean;
	readonly runId?: string;
	readonly task: PromptTaskEnvelopeInput;
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
	readonly identity: PromptTaskIdentity;
	readonly settlement: PromptTaskSettlement;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
	readonly now?: () => string;
}

export interface PromptTaskExecution {
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly dispatch: Dispatch;
	readonly initialBindingEpoch: BindingEpoch;
	readonly agentInstance?: AgentInstance;
	readonly run: { readonly runId: string } & RunOutcome;
	readonly attemptReceipt: AttemptReceipt;
	readonly taskResult: TaskResult;
	readonly runReceipt: RunReceipt;
}

export interface PromptTaskCompositionRootOptions {
	readonly dependencies: PromptTaskCompositionDependencies;
	readonly provider: TaskExecutorProvider;
	readonly harness: Omit<CreateCodingAgentHarnessOptions, "env" | "foundationExecution" | "foundationProvider"> & {
		readonly env?: CreateCodingAgentHarnessOptions["env"];
	};
	/** Long-lived runtime authority used by product entry points. */
	readonly runtimeHarness?: AgentHarness;
	readonly ownerId?: string;
	/** Shared durable writer for composition into a long-lived Harness. */
	readonly writer?: SessionLedgerWriter;
	/** Explicit product ingress for @agent and description selection. Omission preserves the existing path. */
	readonly subagentRoles?: {
		readonly registry: Pick<RoleRegistry, "get" | "search" | "resolve">;
		readonly scope: "global" | "project";
		readonly parentLaneId: string;
		spawn(input: PromptTaskSubagentSpawnInputV1): Promise<ResultValue<PromptTaskSubagentSpawnResultV1, FoundationError>>;
		/** Fixed trusted Host composition. Presence makes composition independent of prompt/model selection. */
		compose?(input: PromptTaskSubagentCompositionInputV1): Promise<ResultValue<PromptTaskSubagentSpawnResultV1, FoundationError>>;
	};
}

export interface PromptTaskSubagentSpawnResultV1 {
	readonly attemptReceiptIds: readonly string[];
}

export interface PromptTaskSubagentCompositionInputV1 {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly prompt: string;
	readonly parentTask: TaskEnvelope;
	readonly parentBinding: AgentBinding;
	readonly parentRoleRevision: RoleRevision;
	readonly parentModelProfile: ModelProfile;
	readonly parentDispatch: Dispatch;
	readonly parentBindingEpoch: BindingEpoch;
	readonly parentAgentInstance: AgentInstance;
	readonly parentCorrelation: ExecutionCorrelation;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
	readonly timestamp: string;
}

export interface PromptTaskSubagentSpawnInputV1 extends PromptTaskSubagentCompositionInputV1 {
	readonly selectedRoleRevision: RoleRevision;
}

export interface PromptTaskAdapter {
	execute(input: PromptTaskInput): Promise<PromptTaskExecution>;
}

type ResolvedPromptTaskDependencies = Record<PromptTaskDependencyName, PromptTaskDependencyResolution>;
const SECRET_BEARING_DEPENDENCY_FIELDS = new Set(["token", "accesstoken", "refreshtoken", "password", "secret", "authorization", "apikey", "headers", "environment", "env", "material"]);

function requireNonempty(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new PromptTaskCompositionError("prompt_task_input_invalid", `${field} must be a non-empty string`);
}

function validateSettlementPrerequisites(input: PromptTaskInput): void {
	const settlement = input.settlement as PromptTaskSettlement | undefined;
	if (settlement === undefined || !Array.isArray(settlement.artifacts) || !Array.isArray(settlement.tests) || !Array.isArray(settlement.evidence)) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task settlement artifacts, tests, and evidence are required before provider execution");
	}
	const requiredTests = settlement.tests.filter((test) => test.required);
	const requiresAcceptanceProof = input.task.expectedOutputs.length > 0 || input.task.acceptanceCriteria.some((criterion) => criterion.required);
	if (
		requiredTests.some((test) => test.status !== "passed") ||
		(requiresAcceptanceProof && !requiredTests.some((test) => test.status === "passed"))
	) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task settlement requires at least one passed required test and no unmet required test");
	}
	for (const expected of input.task.expectedOutputs) {
		if (!settlement.artifacts.some((artifact) => artifact.artifactId === expected.artifactId && artifact.digest === expected.digest)) {
			throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task settlement is missing expected output ${expected.artifactId}`);
		}
	}
	for (const criterion of input.task.acceptanceCriteria) {
		if (!criterion.required) continue;
		const evidence = settlement.evidence.find((fact) => fact.criterionId === criterion.criterionId && fact.outcome === "satisfied");
		if (evidence?.evidenceRefs === undefined || evidence.evidenceRefs.length === 0) {
			throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task settlement is missing evidence for ${criterion.criterionId}`);
		}
	}
}

function containsSecretBearingField(value: FoundationJsonValue): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(containsSecretBearingField);
	return Object.entries(value).some(([key, child]) => SECRET_BEARING_DEPENDENCY_FIELDS.has(key.replaceAll(/[_-]/g, "").toLowerCase()) || containsSecretBearingField(child));
}

function validateCompositionRootDependencies(dependencies: PromptTaskCompositionDependencies): void {
	const record = dependencies as unknown as Record<string, unknown>;
	for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
		const candidate = record[name];
		if (candidate === undefined) throw new PromptTaskCompositionError("prompt_task_dependency_missing", `Prompt Task composition requires the ${name} dependency`, name);
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency is invalid`, name);
		const dependency = candidate as Partial<PromptTaskDependency>;
		if (dependency.name !== name || !Number.isInteger(dependency.revision) || (dependency.revision ?? 0) < 1 || typeof dependency.resolve !== "function") {
			throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency must expose its exact name, revision, and resolver`, name);
		}
	}
}

function validateDependencyResolution(name: PromptTaskDependencyName, declaredRevision: number, value: PromptTaskDependencyResolution): PromptTaskDependencyResolution {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned no immutable binding fact`, name);
	const checkedReference = validateVersionedReference(value.reference);
	if (!checkedReference.ok) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned an invalid revision reference`, name, checkedReference.error);
	const reference = checkedReference.value;
	if (reference.revision === undefined || reference.revision !== declaredRevision || reference.revision < 1 || reference.fingerprint === undefined || reference.type !== PROMPT_TASK_DEPENDENCY_FACT_TYPES[name]) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned the wrong immutable fact type or revision`, name);
	}
	if (!validateProviderJson(value.payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned a non-JSON binding fact`, name);
	const payload = value.payload;
	if (containsSecretBearingField(payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned secret-bearing material instead of an immutable reference`, name);
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned a non-object binding fact`, name);
	if (payload.schemaVersion !== 1 || payload.type !== reference.type || payload.id !== reference.id || payload.revision !== reference.revision) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency fact does not match its revision reference`, name);
	}
	if (fingerprintFoundationValue(payload).value !== reference.fingerprint.value) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency fact fingerprint does not match its payload`, name);
	}
	return { reference: { ...reference, revision: reference.revision, fingerprint: reference.fingerprint }, payload: structuredClone(payload) };
}

async function resolveDependencies(
	dependencies: PromptTaskCompositionDependencies,
	context: PromptTaskDependencyContext,
): Promise<ResolvedPromptTaskDependencies> {
	const resolved = {} as ResolvedPromptTaskDependencies;
	for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
		try {
			resolved[name] = validateDependencyResolution(name, dependencies[name].revision, await dependencies[name].resolve(context));
		} catch (error) {
			if (error instanceof PromptTaskCompositionError) throw error;
			throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency resolution failed`, name, error);
		}
	}
	return resolved;
}

async function persistImmutableFact(
	ledger: SessionLedger,
	objectType: string,
	objectId: string,
	payload: FoundationJsonValue,
	taskId: string,
	bindingId: string,
	clientRequestId: string,
): Promise<void> {
	const existing = await ledger.get(objectType, objectId);
	if (existing !== undefined) {
		if (existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return;
		throw new PromptTaskCompositionError("prompt_task_binding_invalid", `Durable ${objectType} ${objectId} conflicts with the Prompt Task binding`);
	}
	await ledger.appendFact(objectType, objectId, payload, {
		clientRequestId,
		expectedRevision: 0,
		correlation: { taskId, bindingId },
	});
}

async function persistBindingSources(
	options: PromptTaskCompositionRootOptions,
	input: PromptTaskInput,
	resolved: ResolvedPromptTaskDependencies,
): Promise<void> {
	const ledger = new SessionLedger(options.harness.session, { ownerId: options.ownerId ?? `prompt-task:${input.identity.bindingId}`, writer: options.writer });
	try {
		await persistImmutableFact(ledger, "role_revision", input.roleRevision.roleRevisionId, input.roleRevision as unknown as FoundationJsonValue, input.task.taskId, input.identity.bindingId, `prompt-task:role:${input.roleRevision.roleRevisionId}`);
		await persistImmutableFact(ledger, "model_profile_revision", input.modelProfile.modelProfileId, input.modelProfile as unknown as FoundationJsonValue, input.task.taskId, input.identity.bindingId, `prompt-task:model-profile:${input.modelProfile.modelProfileId}`);
		for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
			const resolution = resolved[name];
			await persistImmutableFact(ledger, resolution.reference.type, resolution.reference.id, resolution.payload, input.task.taskId, input.identity.bindingId, `prompt-task:${name}:${resolution.reference.id}`);
		}
	} finally {
		await ledger.release();
	}
}

function createTask(input: PromptTaskInput, timestamp: string): TaskEnvelope {
	const created = createTaskEnvelope({
		...input.task,
		schemaVersion: 1,
		goal: input.prompt,
		status: "ready",
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	if (!created.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task input could not create a TaskEnvelope", undefined, created.error);
	return created.value;
}

function createBinding(
	input: PromptTaskInput,
	task: TaskEnvelope,
	resolved: ResolvedPromptTaskDependencies,
	timestamp: string,
): AgentBinding {
	const binding = resolveAgentBinding({
		task,
		roleRevision: input.roleRevision,
		modelProfile: input.modelProfile,
		externalAgentBindingRevision: resolved.adapter.reference,
		capabilityRevision: resolved.capability.reference,
		modelBrokerBindingRevision: resolved.model.reference,
		policyRevision: resolved.policy.reference,
		sourceTrace: PROMPT_TASK_DEPENDENCY_NAMES.map((name) => ({ field: name, layer: "task" as const, referenceId: resolved[name].reference.id, revision: resolved[name].reference.revision })),
		newBindingId: input.identity.bindingId,
		now: () => timestamp,
	});
	if (!binding.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task dependency facts could not resolve an AgentBinding", undefined, binding.error);
	return binding.value;
}

function explicitAgentQuery(prompt: string): string | undefined {
	const match = /^\s*@agent\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,255})(?:\s|$)/u.exec(prompt);
	return match?.[1];
}

function selectSubagentRole(
	options: NonNullable<PromptTaskCompositionRootOptions["subagentRoles"]>,
	prompt: string,
): RoleRevision | undefined {
	const explicit = explicitAgentQuery(prompt);
	if (explicit !== undefined) {
		const byId = options.registry.get({ roleId: explicit, scope: options.scope });
		if (byId.ok) return byId.value.currentRevision;
		const byDescription = options.registry.search({ text: explicit, scope: options.scope });
		if (!byDescription.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Explicit @agent role could not be resolved", undefined, byDescription.error);
		const exact = byDescription.value.find((record) => record.definition.slug === explicit || record.roleId === explicit);
		if (exact === undefined) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Explicit @agent role was not found");
		return exact.currentRevision;
	}
	const terms = prompt.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/gu) ?? [];
	for (const term of terms) {
		const found = options.registry.search({ text: term, scope: options.scope });
		if (!found.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Subagent description selection failed", undefined, found.error);
		if (found.value.length > 0) return found.value[0]!.currentRevision;
	}
	return undefined;
}

function createDispatch(input: PromptTaskInput, task: TaskEnvelope, provider: TaskExecutorProvider, timestamp: string): Dispatch {
	const dispatch = validateDispatch({ schemaVersion: 1, dispatchId: input.identity.dispatchId, taskId: task.taskId, bindingId: input.identity.bindingId, taskExecutorProviderId: provider.providerId, status: "pending", createdAt: timestamp });
	if (!dispatch.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create a Dispatch", undefined, dispatch.error);
	return dispatch.value;
}

function createExecutionIdentity(
	input: PromptTaskInput,
	task: TaskEnvelope,
	provider: TaskExecutorProvider,
	timestamp: string,
): { readonly epoch: BindingEpoch; readonly agentInstance?: AgentInstance } {
	const isAgent = provider.providerClass === "agent";
	if (isAgent !== (input.identity.agentInstanceId !== undefined)) throw new PromptTaskCompositionError("prompt_task_input_invalid", isAgent ? "Agent provider requires agentInstanceId" : "Non-agent provider forbids agentInstanceId");
	const epoch = createOrderedBindingEpoch({ bindingEpochId: input.identity.bindingEpochId, taskId: task.taskId, attemptId: input.identity.attemptId, bindingId: input.identity.bindingId, activationReason: "attempt_started", activatedByCommandId: input.identity.dispatchId, ...(input.identity.agentInstanceId === undefined ? {} : { agentInstanceId: input.identity.agentInstanceId }), now: () => timestamp });
	if (!epoch.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create the initial BindingEpoch", undefined, epoch.error);
	if (!isAgent || input.identity.agentInstanceId === undefined) return { epoch: epoch.value };
	const created = createAgentInstance({ agentInstanceId: input.identity.agentInstanceId, providerId: provider.providerId, providerDeclaredAgent: true, roleRevision: input.roleRevision, taskId: task.taskId, now: () => timestamp });
	if (!created.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create an AgentInstance", undefined, created.error);
	return { epoch: epoch.value, agentInstance: { ...created.value, bindingEpochIds: [epoch.value.bindingEpochId] } };
}

async function findRunReceiptUsage(
	session: CreateCodingAgentHarnessOptions["session"],
	runId: string,
): Promise<RunReceipt["usage"]> {
	const usage: RunReceipt["usage"] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	for (const record of await session.findRecords({ runId, type: "usage", order: "oldestFirst" })) {
		usage.inputTokens += record.usage.input;
		usage.outputTokens += record.usage.output;
		usage.totalTokens += record.usage.totalTokens;
	}
	return usage;
}

export function createPromptTaskAdapter(options: PromptTaskCompositionRootOptions): PromptTaskAdapter {
	validateCompositionRootDependencies(options.dependencies);
	requireNonempty(options.provider.providerId, "provider.providerId");
	if (options.harness.drive === "manual") throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires automatic Harness drive to produce terminal receipts");
	if (options.runtimeHarness === undefined && options.harness.env === undefined) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires an execution environment when it creates a Harness");
	}
	if (options.runtimeHarness !== undefined && options.runtimeHarness.session !== options.harness.session) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task runtime Harness must use the composition Session");
	}
	if (options.runtimeHarness !== undefined && options.writer !== options.runtimeHarness.t5.writer) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task runtime Harness must share its Session ledger writer with the composition root");
	}
	return {
		async execute(input) {
			requireNonempty(input.prompt, "prompt");
			if (input.runId !== undefined) requireNonempty(input.runId, "runId");
			if (input.signal?.aborted) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task was aborted before execution");
			if (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs < 0)) {
				throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task deadlineMs must be non-negative");
			}
			for (const [field, value] of Object.entries(input.identity)) requireNonempty(value, `identity.${field}`);
			validateSettlementPrerequisites(input);
			const timestamp = (input.now ?? (() => new Date().toISOString()))();
			if (Number.isNaN(Date.parse(timestamp))) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task clock must return an ISO timestamp");
			const selectedRole = options.subagentRoles === undefined || options.subagentRoles.compose !== undefined
				? undefined
				: selectSubagentRole(options.subagentRoles, input.prompt);
			const childExecutionConfigured = selectedRole !== undefined || options.subagentRoles?.compose !== undefined;
			const checkedRole = validateRoleRevision(input.roleRevision);
			if (!checkedRole.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task RoleRevision is invalid", undefined, checkedRole.error);
			const { fingerprint: _roleFingerprint, ...roleBase } = checkedRole.value;
			if (fingerprintFoundationValue(roleBase).value !== checkedRole.value.fingerprint.value) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task RoleRevision fingerprint is invalid");
			const checkedProfile = validateSecretFreeModelProfile(input.modelProfile);
			if (!checkedProfile.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task ModelProfile is invalid", undefined, checkedProfile.error);
			const normalizedInput = { ...input, roleRevision: checkedRole.value, modelProfile: checkedProfile.value };
			const task = createTask(normalizedInput, timestamp);
			const persistedTask = await persistTaskEnvelopeBeforeResolver(options.harness.session, task, { ownerId: options.ownerId, writer: options.writer });
			if (!persistedTask.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task TaskEnvelope could not be persisted before resolution", undefined, persistedTask.error);
			const resolved = await resolveDependencies(options.dependencies, { prompt: input.prompt, task: persistedTask.value, roleRevision: checkedRole.value, modelProfile: checkedProfile.value });
			if (resolved.adapter.reference.providerId !== options.provider.providerId) {
				throw new PromptTaskCompositionError("prompt_task_dependency_invalid", "Prompt Task Adapter binding does not match the trusted execution provider", "adapter");
			}
			await persistBindingSources(options, normalizedInput, resolved);
			const binding = createBinding(normalizedInput, persistedTask.value, resolved, timestamp);
			const dispatch = createDispatch(normalizedInput, persistedTask.value, options.provider, timestamp);
			const identity = createExecutionIdentity(normalizedInput, persistedTask.value, options.provider, timestamp);
			const foundationExecution: AgentHarnessFoundationExecution = {
				task: persistedTask.value,
				binding,
				dispatch,
				providerId: options.provider.providerId,
				initialBindingEpoch: identity.epoch,
				bindingEpochIds: [identity.epoch.bindingEpochId],
				...(identity.agentInstance === undefined ? {} : { agentInstanceId: identity.agentInstance.agentInstanceId, agentInstance: identity.agentInstance }),
			};
			let created: { harness: AgentHarness };
			if (options.runtimeHarness === undefined) {
				const env = options.harness.env;
				if (env === undefined) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires an execution environment when it creates a Harness");
				created = await createCodingAgentHarness({
					...options.harness,
					env,
					foundationProvider: options.provider,
					foundationExecution,
				});
			} else {
				created = { harness: options.runtimeHarness };
			}
			if (options.runtimeHarness !== undefined) {
				await created.harness.activateFoundationExecution(foundationExecution, options.provider);
			}
			let childAttemptReceiptIds: readonly string[] = [];
			let parentCorrelationForSettlement: ExecutionCorrelation | undefined;
			if (childExecutionConfigured && options.subagentRoles !== undefined) {
				if (input.runId === undefined) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Selected Child Agent execution requires a stable runId");
				if (identity.agentInstance === undefined) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Selected Child Agent execution requires a parent AgentInstance");
				const checkedSelectedRole = selectedRole === undefined ? undefined : validateRoleRevision(selectedRole);
				if (checkedSelectedRole !== undefined && !checkedSelectedRole.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Selected Child Agent RoleRevision is invalid", undefined, checkedSelectedRole.error);
				const metadata = await options.harness.session.getMetadata();
				const parentCorrelation: ExecutionCorrelation = {
					sessionId: metadata.id,
					laneId: options.subagentRoles.parentLaneId,
					runId: input.runId,
					operationId: input.runId,
					taskId: persistedTask.value.taskId,
					dispatchId: dispatch.dispatchId,
					attemptId: identity.epoch.attemptId,
					bindingId: binding.bindingId,
					bindingEpochId: identity.epoch.bindingEpochId,
					agentInstanceId: identity.agentInstance.agentInstanceId,
					providerId: options.provider.providerId,
					revision: 0,
				};
				parentCorrelationForSettlement = parentCorrelation;
				const settlement = new LayeredResultSettlement(options.harness.session, {
					ownerId: options.ownerId ?? `prompt-task:${binding.bindingId}`,
					writer: options.writer ?? created.harness.t5.writer,
				});
				try {
					const started = await settlement.startDispatch({
						dispatch,
						binding,
						initialBindingEpoch: identity.epoch,
						provider: options.provider,
						agentInstance: identity.agentInstance,
						correlation: parentCorrelation,
						...(input.signal === undefined ? {} : { signal: input.signal }),
					});
					if (!started.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Parent Attempt could not be persisted before Child Agent spawn", undefined, started.error);
					const durableParent = await options.harness.session.getFoundationObject("agent_instance", identity.agentInstance.agentInstanceId);
					const checkedDurableParent = durableParent?.kind === "fact"
						? validateAgentInstance(durableParent.payload)
						: undefined;
					if (checkedDurableParent === undefined || !checkedDurableParent.ok) {
						throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Parent AgentInstance proof is not durable before Child Agent spawn");
					}
					const childInput: PromptTaskSubagentCompositionInputV1 = {
						schemaVersion: 1,
						runId: input.runId,
						prompt: input.prompt,
						parentTask: persistedTask.value,
						parentBinding: binding,
						parentRoleRevision: checkedRole.value,
						parentModelProfile: checkedProfile.value,
						parentDispatch: dispatch,
						parentBindingEpoch: identity.epoch,
						parentAgentInstance: checkedDurableParent.value,
						parentCorrelation,
						...(input.signal === undefined ? {} : { signal: input.signal }),
						...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
						timestamp,
					};
					let spawned: ResultValue<PromptTaskSubagentSpawnResultV1, FoundationError>;
					if (options.subagentRoles.compose !== undefined) {
						spawned = await options.subagentRoles.compose(childInput);
					} else {
						if (checkedSelectedRole === undefined || !checkedSelectedRole.ok) {
							throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Selected Child Agent RoleRevision is missing");
						}
						spawned = await options.subagentRoles.spawn({ ...childInput, selectedRoleRevision: checkedSelectedRole.value });
					}
					if (!spawned.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Selected Child Agent execution failed", undefined, spawned.error);
					if (
						spawned.value.attemptReceiptIds.length === 0 ||
						new Set(spawned.value.attemptReceiptIds).size !== spawned.value.attemptReceiptIds.length ||
						spawned.value.attemptReceiptIds.some((id) => typeof id !== "string" || id.length === 0)
					) {
						throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Selected Child Agent did not return unique durable AttemptReceipt ids");
					}
					childAttemptReceiptIds = [...spawned.value.attemptReceiptIds];
				} finally {
					await settlement.release();
				}
			}
			if (input.signal?.aborted) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task was aborted before provider execution");
			let execution: PromptTaskExecution | undefined;
			let executionError: unknown;
			try {
				const preflight = (signal: AbortSignal): void => {
					if (signal.aborted) throw signal.reason;
				};
				const runOptions = {
					...(input.runId === undefined ? {} : { runId: input.runId }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
				};
				const run = input.continuation === true
					? await created.harness.continueWithPreflight(preflight, runOptions)
					: await created.harness.promptWithPreflight(input.prompt, preflight, {
						...runOptions,
						...(input.images === undefined ? {} : { images: [...input.images] }),
					});
				if (!run.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task Harness rejected the prompt: ${run.error.message}`, undefined, run.error);
				const metadata = await options.harness.session.getMetadata();
				const settlementCorrelation: ExecutionCorrelation = parentCorrelationForSettlement ?? {
					sessionId: metadata.id,
					laneId: "main",
					runId: run.value.runId,
					operationId: run.value.runId,
					goalId: persistedTask.value.goalId,
					taskId: persistedTask.value.taskId,
					dispatchId: dispatch.dispatchId,
					attemptId: identity.epoch.attemptId,
					bindingId: binding.bindingId,
					bindingEpochId: identity.epoch.bindingEpochId,
					...(identity.agentInstance === undefined ? {} : { agentInstanceId: identity.agentInstance.agentInstanceId }),
					providerId: options.provider.providerId,
					revision: 0,
				};
				const settlement = new LayeredResultSettlement(options.harness.session, {
					ownerId: options.ownerId ?? `prompt-task:${binding.bindingId}`,
					writer: options.writer ?? created.harness.t5.writer,
				});
				let attemptReceipt: AttemptReceipt;
				let taskResult: TaskResult;
				let runReceipt: RunReceipt;
				try {
					const attemptRecords = await options.harness.session.findFoundationRecords({
						kind: "fact",
						objectType: "attempt_receipt",
						order: "oldestFirst",
					});
					const attemptRecord = attemptRecords.find((candidate) =>
						candidate.kind === "fact" &&
						(candidate.payload as { attemptId?: unknown }).attemptId === input.identity.attemptId,
					);
					if (attemptRecord?.kind === "fact") {
						attemptReceipt = attemptRecord.payload as unknown as AttemptReceipt;
					} else {
						// AgentHarness already performed and durably recorded the model/tool work. This
						// fallback only asks the coding-agent provider to project those records into
						// the missing parent AttemptReceipt; it never prompts the Harness or provider
						// model again. executeDispatch also replays a receipt that became durable first.
						const executed = await settlement.executeDispatch({
							provider: options.provider,
							dispatch,
							binding,
							initialBindingEpoch: identity.epoch,
							...(identity.agentInstance === undefined ? {} : { agentInstance: identity.agentInstance }),
							correlation: settlementCorrelation,
						});
						if (!executed.ok) throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Provider consumer rejected the Prompt Task AttemptReceipt", undefined, executed.error);
						attemptReceipt = executed.value.receipt;
					}
					const sourceAttemptReceiptIds = [attemptReceipt.attemptReceiptId, ...childAttemptReceiptIds];
					if (new Set(sourceAttemptReceiptIds).size !== sourceAttemptReceiptIds.length) {
						throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Parent and accepted Child AttemptReceipt ids must be unique");
					}
					const taskResultId = `task_result_${run.value.runId}`;
					const settled = await settlement.settle({
						taskResultId,
						task: persistedTask.value,
						sourceAttemptReceiptIds: [attemptReceipt.attemptReceiptId],
						...(childAttemptReceiptIds.length === 0 ? {} : { provenanceAttemptReceiptIds: childAttemptReceiptIds }),
						summary: input.settlement.summary ?? (run.value.kind === "completed" ? "Agent run completed" : "Agent run did not complete successfully"),
						artifacts: input.settlement.artifacts,
						...(input.settlement.diff === undefined ? {} : { diff: input.settlement.diff }),
						tests: input.settlement.tests,
						evidence: input.settlement.evidence,
						producer: {
							producerKind: "host",
							providerId: resolved.gate.reference.id,
							producedAt: timestamp,
							correlation: { ...settlementCorrelation, taskResultId, attemptReceiptId: attemptReceipt.attemptReceiptId },
						},
					});
					if (!settled.ok) throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Host settlement rejected the Prompt Task result", undefined, settled.error);
					taskResult = settled.value;
					const terminalStatus = attemptReceipt.sideEffectState !== "none"
						? "failed"
						: run.value.kind === "completed" && taskResult.status === "succeeded"
							? "completed"
							: run.value.kind === "aborted" && taskResult.status === "cancelled"
								? "cancelled"
								: "failed";
					const usage = await findRunReceiptUsage(options.harness.session, run.value.runId);
					const finalized = await settlement.finalize({
						runReceiptId: `run_receipt_${run.value.runId}`,
						runId: run.value.runId,
						terminalStatus,
						authority: createHostTerminalGateAuthority(resolved.gate.reference.id, resolved.gate.reference.revision),
						attemptReceiptIds: sourceAttemptReceiptIds,
						taskResultId: taskResult.taskResultId,
						usage,
						completedAt: timestamp,
					});
					if (!finalized.ok) throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Host terminal gate rejected the Prompt Task RunReceipt", undefined, finalized.error);
					runReceipt = finalized.value;
				} finally {
					await settlement.release();
				}
				execution = { task: persistedTask.value, binding, dispatch, initialBindingEpoch: identity.epoch, ...(identity.agentInstance === undefined ? {} : { agentInstance: identity.agentInstance }), run: run.value, attemptReceipt, taskResult, runReceipt };
			} catch (error) {
				executionError = error;
			}
			let closeError: unknown;
			if (options.runtimeHarness === undefined) {
				try {
					await created.harness.close();
				} catch (error) {
					closeError = error;
				}
			}
			if (executionError !== undefined) throw executionError;
			if (closeError !== undefined) throw closeError;
			if (execution === undefined) throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Prompt Task execution ended without a terminal result");
			return execution;
		},
	};
}
